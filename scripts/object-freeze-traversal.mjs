import { relative, sep } from 'node:path';
import ts from 'typescript';

const MUTABLE_BUILT_INS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const TYPED_ARRAYS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array'
]);

/** Bounded checker-assisted analysis. Dynamic `any` factories remain runtime-boundary work. */
export function collectFrozenMutableExposures(argument, freeze, path, source, checker, sourceRoot) {
  const results = [];
  const emitted = new Set();
  const context = {
    checker,
    freeze,
    path,
    source,
    sourceRoot,
    resolvingSymbols: new Set(),
    resolvingNodes: new Set()
  };
  collectValue(argument, '', context, results, emitted);
  return results;
}

function collectValue(expression, propertyPath, context, results, emitted) {
  const value = unwrapExpression(expression);
  if (context.resolvingNodes.has(value)) return;
  const mutableKind = mutableBuiltinKind(value, context);
  if (mutableKind) {
    emitExposure(propertyPath, mutableKind, context, results, emitted);
    return;
  }
  context.resolvingNodes.add(value);
  try {
    if (ts.isObjectLiteralExpression(value)) {
      collectObject(value, propertyPath, context, results, emitted);
    } else if (ts.isArrayLiteralExpression(value)) {
      collectArray(value, propertyPath, context, results, emitted);
    } else if (ts.isIdentifier(value)) {
      withSymbolInitializers(value, context, (initializer) =>
        collectValue(initializer, propertyPath, context, results, emitted)
      );
    } else if (ts.isPropertyAccessExpression(value)) {
      for (const initializer of memberInitializers(value.expression, value.name.text, context)) {
        collectValue(initializer, propertyPath, context, results, emitted);
      }
    } else if (ts.isElementAccessExpression(value)) {
      const name = elementName(value.argumentExpression, context);
      if (name !== undefined) {
        for (const initializer of memberInitializers(value.expression, name, context)) {
          collectValue(initializer, propertyPath, context, results, emitted);
        }
      }
    } else if (ts.isConditionalExpression(value)) {
      collectValue(value.whenTrue, propertyPath, context, results, emitted);
      collectValue(value.whenFalse, propertyPath, context, results, emitted);
    } else if (ts.isCallExpression(value)) {
      for (const returned of callableReturnExpressions(value.expression, context)) {
        collectValue(returned, propertyPath, context, results, emitted);
      }
    } else if (value.kind === ts.SyntaxKind.ThisKeyword) {
      for (const initializer of thisPropertyInitializers(value, context)) {
        collectValue(
          initializer.value,
          appendPath(propertyPath, initializer.name),
          context,
          results,
          emitted
        );
      }
    }
  } finally {
    context.resolvingNodes.delete(value);
  }
}

function collectObject(object, prefix, context, results, emitted) {
  for (const [name, value] of materializeObjectProperties(object, context)) {
    collectValue(value, appendPath(prefix, name), context, results, emitted);
  }
}

function collectArray(array, prefix, context, results, emitted) {
  for (let index = 0; index < array.elements.length; index++) {
    const element = array.elements[index];
    if (!element || ts.isOmittedExpression(element)) continue;
    const path = `${prefix}[${index}]`;
    if (ts.isSpreadElement(element))
      collectArraySpread(element.expression, path, context, results, emitted);
    else collectValue(element, path, context, results, emitted);
  }
}

function collectArraySpread(expression, prefix, context, results, emitted) {
  const values = iterableElements(expression, context);
  for (let index = 0; index < values.length; index++) {
    collectValue(
      values[index],
      index === 0 ? prefix : `${prefix}[${index}]`,
      context,
      results,
      emitted
    );
  }
}

function iterableElements(expression, context) {
  const value = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements
      .filter((element) => !ts.isOmittedExpression(element))
      .map((element) => (ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isNewExpression(value) && mutableBuiltinKind(value, context) === 'Set') {
    const initial = value.arguments?.[0];
    return initial ? iterableElements(initial, context) : [];
  }
  if (ts.isIdentifier(value)) {
    return symbolInitializers(value, context).flatMap((initializer) =>
      iterableElements(initializer, context)
    );
  }
  if (ts.isPropertyAccessExpression(value)) {
    return memberInitializers(value.expression, value.name.text, context).flatMap((initializer) =>
      iterableElements(initializer, context)
    );
  }
  return [];
}

/** Object spread evaluates left-to-right, so a later property cancels an earlier mutable alias. */
function materializeObjectProperties(expression, context) {
  const object = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(object)) {
    if (ts.isIdentifier(object)) {
      return symbolInitializers(object, context).flatMap((initializer) =>
        materializeObjectProperties(initializer, context)
      );
    }
    if (ts.isPropertyAccessExpression(object)) {
      return memberInitializers(object.expression, object.name.text, context).flatMap(
        (initializer) => materializeObjectProperties(initializer, context)
      );
    }
    return [];
  }
  const values = new Map();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const [name, value] of materializeObjectProperties(property.expression, context)) {
        values.set(name, value);
      }
      continue;
    }
    const name = propertyName(property, context);
    const value = propertyValue(property);
    if (name !== undefined && value !== undefined) values.set(name, value);
  }
  return [...values];
}

function memberInitializers(containerExpression, memberName, context) {
  const container = unwrapExpression(containerExpression);
  if (ts.isObjectLiteralExpression(container)) {
    return materializeObjectProperties(container, context)
      .filter(([name]) => name === memberName)
      .map(([, value]) => value);
  }
  if (ts.isArrayLiteralExpression(container) && /^\d+$/.test(memberName)) {
    const element = container.elements[Number(memberName)];
    return element && !ts.isOmittedExpression(element)
      ? [ts.isSpreadElement(element) ? element.expression : element]
      : [];
  }
  if (ts.isIdentifier(container)) {
    return symbolInitializers(container, context).flatMap((initializer) =>
      memberInitializers(initializer, memberName, context)
    );
  }
  if (ts.isPropertyAccessExpression(container)) {
    return memberInitializers(container.expression, container.name.text, context).flatMap(
      (initializer) => memberInitializers(initializer, memberName, context)
    );
  }
  if (container.kind === ts.SyntaxKind.ThisKeyword) {
    return thisPropertyInitializers(container, context)
      .filter((entry) => entry.name === memberName)
      .map((entry) => entry.value);
  }
  return [];
}

function thisPropertyInitializers(thisExpression, context) {
  const classNode = nearestClass(thisExpression) ?? nearestClass(context.freeze);
  if (!classNode) return [];
  const values = new Map();
  for (const member of classNode.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.initializer ||
      hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
      ts.isPrivateIdentifier(member.name)
    ) {
      continue;
    }
    const name = memberName(member.name);
    if (name !== undefined) values.set(name, member.initializer);
  }
  for (const member of classNode.members) {
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    for (const assignment of constructorAssignments(member, context.freeze)) {
      values.set(assignment.name, assignment.value);
    }
  }
  return [...values].map(([name, value]) => ({ name, value }));
}

function constructorAssignments(constructor, freeze) {
  const results = [];
  const freezeStart =
    constructor.pos <= freeze.pos && freeze.end <= constructor.end ? freeze.pos : Infinity;
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.getStart() < freezeStart
    ) {
      results.push({ name: node.left.name.text, value: node.right });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(constructor.body, visit);
  return results;
}

function callableReturnExpressions(expression, context) {
  const value = unwrapExpression(expression);
  if (
    ts.isArrowFunction(value) ||
    ts.isFunctionExpression(value) ||
    ts.isFunctionDeclaration(value)
  ) {
    return returnExpressions(value);
  }
  if (ts.isIdentifier(value)) {
    const symbol = symbolFor(value, context);
    return symbol
      ? (symbol.declarations ?? []).flatMap((declaration) =>
          ts.isFunctionDeclaration(declaration) ? returnExpressions(declaration) : []
        )
      : [];
  }
  return [];
}

function returnExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const results = [];
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return results;
}

function mutableBuiltinKind(expression, context) {
  if (ts.isNewExpression(expression)) {
    const constructor = constructorName(expression.expression, context);
    if (constructor && (MUTABLE_BUILT_INS.has(constructor) || TYPED_ARRAYS.has(constructor))) {
      return constructor;
    }
  }
  return mutableKindFromType(expression, context);
}

function constructorName(expression, context) {
  const value = unwrapExpression(expression);
  if (
    ts.isIdentifier(value) &&
    (MUTABLE_BUILT_INS.has(value.text) || TYPED_ARRAYS.has(value.text))
  ) {
    return value.text;
  }
  if (
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'globalThis' &&
    (MUTABLE_BUILT_INS.has(value.name.text) || TYPED_ARRAYS.has(value.name.text))
  ) {
    return value.name.text;
  }
  if (ts.isIdentifier(value)) {
    for (const initializer of symbolInitializers(value, context)) {
      const name = constructorName(initializer, context);
      if (name) return name;
    }
  }
  return undefined;
}

function mutableKindFromType(expression, context) {
  const type = context.checker.getTypeAtLocation(expression);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  return name && (MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name)) ? name : undefined;
}

function withSymbolInitializers(identifier, context, visit) {
  for (const initializer of symbolInitializers(identifier, context)) visit(initializer);
}

function symbolInitializers(identifier, context) {
  const symbol = symbolFor(identifier, context);
  if (!symbol || context.resolvingSymbols.has(symbol)) return [];
  context.resolvingSymbols.add(symbol);
  try {
    return initializerForSymbol(symbol, context);
  } finally {
    context.resolvingSymbols.delete(symbol);
  }
}

function symbolFor(identifier, context) {
  let symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  return symbol;
}

function initializerForSymbol(symbol, context, seen = new Set()) {
  if (seen.has(symbol)) return [];
  seen.add(symbol);
  const results = [];
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
      results.push(declaration.initializer);
    if (ts.isPropertyDeclaration(declaration) && declaration.initializer)
      results.push(declaration.initializer);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(declaration);
      if (valueSymbol) results.push(...initializerForSymbol(valueSymbol, context, seen));
    }
  }
  return results;
}

function emitExposure(propertyPath, kind, context, results, emitted) {
  const exposure = {
    location: sourceLocation(context.path, context.source, context.freeze, context.sourceRoot),
    propertyPath: propertyPath || '<root>',
    kind
  };
  const key = `${exposure.location}\u0000${exposure.propertyPath}\u0000${exposure.kind}`;
  if (!emitted.has(key)) {
    emitted.add(key);
    results.push(exposure);
  }
}

function sourceLocation(path, source, node, sourceRoot) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const displayPath =
    path === 'snippet.ts' ? path : relative(sourceRoot, path).split(sep).join('/');
  return `${displayPath}:${position.line + 1}:${position.character + 1}`;
}

function unwrapExpression(expression) {
  let value = expression;
  while (
    ts.isAsExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function propertyName(property, context) {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    return memberName(property.name, context);
  }
  return undefined;
}

function propertyValue(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function memberName(name, context) {
  if (ts.isComputedPropertyName(name)) return elementName(name.expression, context);
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function elementName(expression, context) {
  const value = expression ? unwrapExpression(expression) : undefined;
  if (value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value))) {
    return value.text;
  }
  if (value && ts.isIdentifier(value)) {
    for (const initializer of symbolInitializers(value, context)) {
      const name = elementName(initializer, context);
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

function appendPath(prefix, member) {
  if (/^\d+$/.test(member)) return `${prefix}[${member}]`;
  return prefix ? `${prefix}.${member}` : member;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function nearestClass(node) {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
    current = current.parent;
  }
  return undefined;
}

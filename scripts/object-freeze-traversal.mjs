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
    } else if (ts.isNewExpression(value)) {
      for (const initializer of classInstanceInitializers(value, context, false)) {
        collectValue(
          initializer.value,
          appendPath(propertyPath, initializer.name),
          context,
          results,
          emitted
        );
      }
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
    collectTypedPropertyExposures(value, propertyPath, context, results, emitted);
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
  if (ts.isNewExpression(container)) {
    return classInstanceInitializers(container, context, true)
      .filter((entry) => entry.name === memberName)
      .map((entry) => entry.value);
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

function classInstanceInitializers(expression, context, includeGetters) {
  const type = context.checker.getTypeAtLocation(expression);
  const symbol = resolvedSymbol(type.aliasSymbol ?? type.getSymbol(), context);
  if (!symbol) return [];
  const values = new Map();
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
    for (const member of declaration.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        !ts.isPrivateIdentifier(member.name)
      ) {
        const name = memberName(member.name, context);
        if (name !== undefined) values.set(name, member.initializer);
      }
      if (
        includeGetters &&
        ts.isGetAccessorDeclaration(member) &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        !ts.isPrivateIdentifier(member.name)
      ) {
        const name = memberName(member.name, context);
        const returned = returnExpressions(member);
        if (name !== undefined && returned.length > 0) values.set(name, returned.at(-1));
      }
      if (ts.isConstructorDeclaration(member) && member.body) {
        for (const assignment of constructorAssignments(member, context.freeze)) {
          values.set(assignment.name, assignment.value);
        }
      }
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
          ts.isFunctionDeclaration(declaration)
            ? returnExpressions(declaration)
            : ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                (ts.isArrowFunction(declaration.initializer) ||
                  ts.isFunctionExpression(declaration.initializer))
              ? returnExpressions(declaration.initializer)
              : []
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
  const value = unwrapExpression(expression);
  if (
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isConditionalExpression(value) ||
    ts.isArrowFunction(value) ||
    ts.isFunctionExpression(value) ||
    ts.isFunctionDeclaration(value)
  ) {
    return undefined;
  }
  return mutableKindFromType(value, context, ts.isCallExpression(value));
}

function mutableKindFromType(expression, context, includeCallReturns = false) {
  return mutableBuiltinTypeKind(
    context.checker.getTypeAtLocation(expression),
    context,
    new Set(),
    includeCallReturns
  );
}

function mutableBuiltinTypeKind(type, context, seen, includeCallReturns = false) {
  if (!type || seen.has(type)) return undefined;
  seen.add(type);
  const symbol = resolvedSymbol(type.aliasSymbol ?? type.getSymbol(), context);
  const direct = standardBuiltinKind(symbol);
  if (direct) return direct;
  const candidates = [
    type.target,
    context.checker.getApparentType(type),
    context.checker.getBaseConstraintOfType(type),
    ...(type.aliasTypeArguments ?? []),
    ...(type.types ?? []),
    ...(includeCallReturns ? callReturnTypes(type, context) : [])
  ];
  try {
    candidates.push(...(context.checker.getBaseTypes(type) ?? []));
  } catch {
    // Only interface/class object types have base types.
  }
  for (const candidate of candidates) {
    const kind = mutableBuiltinTypeKind(candidate, context, seen, includeCallReturns);
    if (kind) return kind;
  }
  return undefined;
}

function callReturnTypes(type, context) {
  return context.checker
    .getSignaturesOfType(type, ts.SignatureKind.Call)
    .map((signature) => context.checker.getReturnTypeOfSignature(signature));
}

function standardBuiltinKind(symbol) {
  if (!symbol || !symbol.declarations?.some(isStandardLibraryDeclaration)) return undefined;
  const name = symbol.getName();
  return MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name) ? name : undefined;
}

function isStandardLibraryDeclaration(declaration) {
  return /(?:^|[\\/])typescript[\\/]lib[\\/]lib\..*\.d\.ts$/.test(
    declaration.getSourceFile().fileName
  );
}

function collectTypedPropertyExposures(expression, propertyPath, context, results, emitted) {
  collectTypeProperties(
    context.checker.getTypeAtLocation(expression),
    propertyPath,
    context,
    results,
    emitted,
    new Set()
  );
}

function collectTypeProperties(type, propertyPath, context, results, emitted, seen) {
  if (!type || seen.has(type) || mutableBuiltinTypeKind(type, context, new Set())) return;
  seen.add(type);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const declarations = (property.declarations ?? []).filter(isRuntimePropertyDeclaration);
    if (declarations.length === 0) continue;
    const name = property.getName();
    if (name.startsWith('#')) continue;
    for (const declaration of declarations) {
      const propertyType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
      const kind = mutableBuiltinTypeKind(propertyType, context, new Set());
      if (kind) emitExposure(appendPath(propertyPath, name), kind, context, results, emitted);
      else
        collectTypeProperties(
          propertyType,
          appendPath(propertyPath, name),
          context,
          results,
          emitted,
          seen
        );
    }
  }
  try {
    for (const indexInfo of context.checker.getIndexInfosOfType(type)) {
      if (indexInfo.declaration && isStandardLibraryDeclaration(indexInfo.declaration)) continue;
      const kind = mutableBuiltinTypeKind(indexInfo.type, context, new Set());
      if (kind) emitExposure(appendIndexPath(propertyPath), kind, context, results, emitted);
      else
        collectTypeProperties(
          indexInfo.type,
          appendIndexPath(propertyPath),
          context,
          results,
          emitted,
          seen
        );
    }
  } catch {
    // Primitive and non-indexable types do not have index information.
  }
}

function isRuntimePropertyDeclaration(declaration) {
  return ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration);
}

function appendIndexPath(prefix) {
  return prefix ? `${prefix}[index]` : '[index]';
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
  return resolvedSymbol(context.checker.getSymbolAtLocation(identifier), context);
}

function resolvedSymbol(symbol, context) {
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
    if (ts.isBindingElement(declaration)) {
      results.push(...bindingElementInitializers(declaration, context));
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(declaration);
      if (valueSymbol) results.push(...initializerForSymbol(valueSymbol, context, seen));
    }
  }
  return results;
}

function bindingElementInitializers(element, context) {
  const pattern = element.parent;
  const declaration = pattern.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return [];
  if (ts.isObjectBindingPattern(pattern)) {
    const name = element.propertyName
      ? memberName(element.propertyName, context)
      : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
    return name === undefined ? [] : memberInitializers(declaration.initializer, name, context);
  }
  if (ts.isArrayBindingPattern(pattern)) {
    const index = pattern.elements.indexOf(element);
    return index < 0
      ? []
      : iterableElements(declaration.initializer, context).slice(index, index + 1);
  }
  return [];
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

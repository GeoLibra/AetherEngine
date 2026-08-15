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
  const mutableKind = mutableBuiltinKind(value);
  if (mutableKind) {
    emitExposure(propertyPath, mutableKind, context, results, emitted);
    return;
  }

  context.resolvingNodes.add(value);
  try {
    if (ts.isObjectLiteralExpression(value)) {
      collectObject(value, propertyPath, context, results, emitted);
      return;
    }
    if (ts.isArrayLiteralExpression(value)) {
      collectArray(value, propertyPath, context, results, emitted);
      return;
    }
    if (ts.isIdentifier(value)) {
      withSymbolInitializer(value, context, (initializer) =>
        collectValue(initializer, propertyPath, context, results, emitted)
      );
      return;
    }
    if (ts.isPropertyAccessExpression(value)) {
      for (const initializer of memberInitializers(value.expression, value.name.text, context)) {
        collectValue(initializer, propertyPath, context, results, emitted);
      }
      return;
    }
    if (ts.isElementAccessExpression(value)) {
      const propertyName = elementName(value.argumentExpression);
      if (propertyName !== undefined) {
        for (const initializer of memberInitializers(value.expression, propertyName, context)) {
          collectValue(initializer, propertyPath, context, results, emitted);
        }
      }
      return;
    }
    if (value.kind === ts.SyntaxKind.ThisKeyword) {
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
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      collectObjectSpread(property.expression, prefix, context, results, emitted);
      continue;
    }
    const name = propertyName(property);
    const value = propertyValue(property);
    if (name !== undefined && value) {
      collectValue(value, appendPath(prefix, name), context, results, emitted);
    }
  }
}

function collectArray(array, prefix, context, results, emitted) {
  for (let index = 0; index < array.elements.length; index++) {
    const element = array.elements[index];
    if (!element || ts.isOmittedExpression(element)) continue;
    const path = `${prefix}[${index}]`;
    if (ts.isSpreadElement(element)) {
      collectArraySpread(element.expression, path, context, results, emitted);
    } else {
      collectValue(element, path, context, results, emitted);
    }
  }
}

function collectObjectSpread(expression, prefix, context, results, emitted) {
  const value = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(value)) {
    collectObject(value, prefix, context, results, emitted);
    return;
  }
  if (ts.isIdentifier(value)) {
    withSymbolInitializer(value, context, (initializer) =>
      collectObjectSpread(initializer, prefix, context, results, emitted)
    );
    return;
  }
  if (ts.isPropertyAccessExpression(value)) {
    for (const initializer of memberInitializers(value.expression, value.name.text, context)) {
      collectObjectSpread(initializer, prefix, context, results, emitted);
    }
  }
}

function collectArraySpread(expression, prefix, context, results, emitted) {
  const value = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(value)) {
    for (let index = 0; index < value.elements.length; index++) {
      const element = value.elements[index];
      if (!element || ts.isOmittedExpression(element)) continue;
      const path = index === 0 ? prefix : `${prefix}[${index}]`;
      if (ts.isSpreadElement(element)) {
        collectArraySpread(element.expression, path, context, results, emitted);
      } else {
        collectValue(element, path, context, results, emitted);
      }
    }
    return;
  }
  if (ts.isIdentifier(value)) {
    withSymbolInitializer(value, context, (initializer) =>
      collectArraySpread(initializer, prefix, context, results, emitted)
    );
    return;
  }
  if (ts.isPropertyAccessExpression(value)) {
    for (const initializer of memberInitializers(value.expression, value.name.text, context)) {
      collectArraySpread(initializer, prefix, context, results, emitted);
    }
  }
}

function memberInitializers(containerExpression, memberName, context) {
  const values = [];
  collectMemberInitializers(unwrapExpression(containerExpression), memberName, context, values);
  return values;
}

function collectMemberInitializers(container, memberName, context, results) {
  if (ts.isObjectLiteralExpression(container)) {
    for (const property of container.properties) {
      if (ts.isSpreadAssignment(property)) {
        collectMemberInitializers(
          unwrapExpression(property.expression),
          memberName,
          context,
          results
        );
        continue;
      }
      if (propertyName(property) === memberName) {
        const value = propertyValue(property);
        if (value) results.push(value);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(container) && /^\d+$/.test(memberName)) {
    const element = container.elements[Number(memberName)];
    if (element && !ts.isOmittedExpression(element)) {
      results.push(ts.isSpreadElement(element) ? element.expression : element);
    }
    return;
  }
  if (ts.isIdentifier(container)) {
    withSymbolInitializer(container, context, (initializer) =>
      collectMemberInitializers(unwrapExpression(initializer), memberName, context, results)
    );
    return;
  }
  if (ts.isPropertyAccessExpression(container)) {
    for (const initializer of memberInitializers(
      container.expression,
      container.name.text,
      context
    )) {
      collectMemberInitializers(unwrapExpression(initializer), memberName, context, results);
    }
    return;
  }
  if (container.kind === ts.SyntaxKind.ThisKeyword) {
    for (const initializer of thisPropertyInitializers(container, context)) {
      if (initializer.name === memberName) results.push(initializer.value);
    }
  }
}

function thisPropertyInitializers(thisExpression, context) {
  const classNode = nearestClass(thisExpression) ?? nearestClass(context.freeze);
  if (!classNode) return [];
  const results = [];
  for (const member of classNode.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.initializer ||
      hasModifier(member, ts.SyntaxKind.StaticKeyword)
    ) {
      continue;
    }
    // TypeScript `private` is still a public runtime property. ECMAScript `#private` is not.
    if (ts.isPrivateIdentifier(member.name)) continue;
    const name = memberName(member.name);
    if (name !== undefined) results.push({ name, value: member.initializer });
  }
  return results;
}

function withSymbolInitializer(identifier, context, visit) {
  let symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol) return;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  if (context.resolvingSymbols.has(symbol)) return undefined;
  const initializer = initializerForSymbol(symbol, context);
  if (!initializer) return;
  context.resolvingSymbols.add(symbol);
  try {
    visit(initializer);
  } finally {
    context.resolvingSymbols.delete(symbol);
  }
}

function initializerForSymbol(symbol, context, seen = new Set()) {
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  const declaration = symbol.declarations?.find(
    (candidate) => ts.isVariableDeclaration(candidate) && candidate.initializer
  );
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return declaration.initializer;
  }
  const shorthand = symbol.declarations?.find(ts.isShorthandPropertyAssignment);
  if (!shorthand || !ts.isShorthandPropertyAssignment(shorthand)) return undefined;
  const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(shorthand);
  return valueSymbol ? initializerForSymbol(valueSymbol, context, seen) : undefined;
}

function mutableBuiltinKind(expression) {
  if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
  const name = expression.expression.text;
  return MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name) ? name : undefined;
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

function propertyName(property) {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    return memberName(property.name);
  }
  return undefined;
}

function propertyValue(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function memberName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function elementName(expression) {
  return expression && (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression))
    ? expression.text
    : undefined;
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

function sourcePath(path) {
  return relative(process.cwd(), path).split(sep).join('/');
}

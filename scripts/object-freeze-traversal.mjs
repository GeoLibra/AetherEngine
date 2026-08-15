import { relative, sep } from 'node:path';
import ts from 'typescript';

const MUTABLE_BUILT_INS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const STANDARD_ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);
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

function collectValue(
  expression,
  propertyPath,
  context,
  results,
  emitted,
  traversal = 'publication'
) {
  const value = unwrapExpression(expression);
  if (context.resolvingNodes.has(value)) return;
  context.resolvingNodes.add(value);
  try {
    if (ts.isIdentifier(value)) {
      const initializers = symbolInitializers(value, context, traversal);
      if (initializers.length > 0) {
        for (const initializer of initializers) {
          collectValue(initializer, propertyPath, context, results, emitted, traversal);
        }
        return;
      }
    } else if (ts.isPropertyAccessExpression(value)) {
      if (ts.isPrivateIdentifier(value.name)) {
        // A private backing field is only relevant while resolving a public slot that returned it.
        if (traversal !== 'public-surface') return;
        const initializers = privateMemberInitializers(
          value.expression,
          value.name.text,
          context,
          traversal
        );
        if (initializers.length > 0) {
          for (const initializer of initializers) {
            collectValue(initializer, propertyPath, context, results, emitted, traversal);
          }
          return;
        }
      }
      const member = memberMaterialization(value.expression, value.name.text, context, traversal);
      if (member.isConcrete) {
        for (const initializer of member.values) {
          collectValue(
            initializer.value,
            propertyPath,
            context,
            results,
            emitted,
            initializer.publicSurface ? 'public-surface' : traversal
          );
        }
        return;
      }
    } else if (ts.isElementAccessExpression(value)) {
      const name = elementName(value.argumentExpression, context);
      if (name !== undefined) {
        const member = memberMaterialization(value.expression, name, context, traversal);
        if (member.isConcrete) {
          for (const initializer of member.values) {
            collectValue(
              initializer.value,
              propertyPath,
              context,
              results,
              emitted,
              initializer.publicSurface ? 'public-surface' : traversal
            );
          }
          return;
        }
      }
    } else if (ts.isConditionalExpression(value)) {
      collectValue(value.whenTrue, propertyPath, context, results, emitted, traversal);
      collectValue(value.whenFalse, propertyPath, context, results, emitted, traversal);
      return;
    } else if (ts.isCallExpression(value)) {
      const returned = callableReturnExpressions(value.expression, context);
      if (returned.length > 0) {
        for (const expression of returned) {
          collectValue(expression, propertyPath, context, results, emitted, traversal);
        }
        return;
      }
      if (isDetachedTypedArrayCopy(value, context)) return;
    }

    const mutableKind = mutableBuiltinKind(value, context);
    if (mutableKind) {
      emitExposure(propertyPath, mutableKind, context, results, emitted);
      return;
    }

    if (ts.isObjectLiteralExpression(value)) {
      collectObject(value, propertyPath, context, results, emitted);
      return;
    } else if (ts.isArrayLiteralExpression(value)) {
      collectArray(value, propertyPath, context, results, emitted);
      return;
    } else if (ts.isNewExpression(value)) {
      for (const initializer of classInstanceInitializers(value, context, true)) {
        collectValue(
          initializer.value,
          appendPath(propertyPath, initializer.name),
          context,
          results,
          emitted,
          'public-surface'
        );
      }
      return;
    } else if (value.kind === ts.SyntaxKind.ThisKeyword) {
      for (const initializer of thisPropertyInitializers(value, context)) {
        collectValue(
          initializer.value,
          appendPath(propertyPath, initializer.name),
          context,
          results,
          emitted,
          'public-surface'
        );
      }
      return;
    }
    collectTypedPropertyExposures(value, propertyPath, context, results, emitted);
  } finally {
    context.resolvingNodes.delete(value);
  }
}

function collectObject(object, prefix, context, results, emitted) {
  for (const [name, values] of materializeObjectProperties(object, context, 'public-surface')) {
    for (const value of values) {
      collectValue(value, appendPath(prefix, name), context, results, emitted, 'public-surface');
    }
  }
}

function collectArray(array, prefix, context, results, emitted) {
  for (let index = 0; index < array.elements.length; index++) {
    const element = array.elements[index];
    if (!element || ts.isOmittedExpression(element)) continue;
    const path = `${prefix}[${index}]`;
    if (ts.isSpreadElement(element))
      collectArraySpread(element.expression, path, context, results, emitted);
    else collectValue(element, path, context, results, emitted, 'public-surface');
  }
}

function collectArraySpread(expression, prefix, context, results, emitted) {
  const values = iterableElements(expression, context, 'public-surface');
  for (let index = 0; index < values.length; index++) {
    collectValue(
      values[index],
      index === 0 ? prefix : `${prefix}[${index}]`,
      context,
      results,
      emitted,
      'public-surface'
    );
  }
}

function iterableElements(expression, context, traversal = 'publication') {
  const value = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(value)) {
    // An elision evaluates as undefined, but it still occupies its source index for destructuring.
    return value.elements.map((element) =>
      ts.isOmittedExpression(element)
        ? ts.factory.createVoidExpression(ts.factory.createNumericLiteral(0))
        : ts.isSpreadElement(element)
          ? element.expression
          : element
    );
  }
  if (ts.isNewExpression(value) && mutableBuiltinKind(value, context) === 'Set') {
    const initial = value.arguments?.[0];
    return initial ? iterableElements(initial, context, traversal) : [];
  }
  if (ts.isIdentifier(value)) {
    return symbolInitializers(value, context, traversal).flatMap((initializer) =>
      iterableElements(initializer, context, traversal)
    );
  }
  if (ts.isPropertyAccessExpression(value)) {
    if (ts.isPrivateIdentifier(value.name)) {
      if (traversal !== 'public-surface') return [];
      return privateMemberInitializers(
        value.expression,
        value.name.text,
        context,
        traversal
      ).flatMap((initializer) => iterableElements(initializer, context, traversal));
    }
    return memberMaterialization(
      value.expression,
      value.name.text,
      context,
      traversal
    ).values.flatMap((entry) =>
      iterableElements(entry.value, context, entry.publicSurface ? 'public-surface' : traversal)
    );
  }
  return [];
}

/** Object spread evaluates left-to-right, so a later property cancels an earlier mutable alias. */
function materializeObjectProperties(expression, context, traversal = 'publication') {
  const object = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(object)) {
    if (ts.isIdentifier(object)) {
      return symbolInitializers(object, context, traversal).flatMap((initializer) =>
        materializeObjectProperties(initializer, context, traversal)
      );
    }
    if (ts.isPropertyAccessExpression(object)) {
      if (ts.isPrivateIdentifier(object.name)) {
        if (traversal !== 'public-surface') return [];
        return privateMemberInitializers(
          object.expression,
          object.name.text,
          context,
          traversal
        ).flatMap((initializer) => materializeObjectProperties(initializer, context, traversal));
      }
      return memberMaterialization(
        object.expression,
        object.name.text,
        context,
        traversal
      ).values.flatMap((entry) =>
        materializeObjectProperties(
          entry.value,
          context,
          entry.publicSurface ? 'public-surface' : traversal
        )
      );
    }
    return [];
  }
  const values = new Map();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const [name, propertyValues] of materializeObjectProperties(
        property.expression,
        context,
        traversal
      )) {
        values.set(name, propertyValues);
      }
      continue;
    }
    const name = propertyName(property, context);
    const valuesForProperty = propertyValues(property);
    if (name !== undefined && valuesForProperty.length > 0) values.set(name, valuesForProperty);
  }
  return [...values];
}

/** A concrete object decides missing/undefined properties from its own materialization, not type. */
function memberMaterialization(
  containerExpression,
  memberName,
  context,
  traversal = 'publication'
) {
  const container = unwrapExpression(containerExpression);
  if (ts.isObjectLiteralExpression(container)) {
    return {
      isConcrete: true,
      values: materializeObjectProperties(container, context, 'public-surface')
        .filter(([name]) => name === memberName)
        .flatMap(([, values]) => values.map((value) => ({ value, publicSurface: true })))
    };
  }
  if (ts.isArrayLiteralExpression(container) && /^\d+$/.test(memberName)) {
    const element = container.elements[Number(memberName)];
    return {
      isConcrete: true,
      values:
        element && !ts.isOmittedExpression(element)
          ? [
              {
                value: ts.isSpreadElement(element) ? element.expression : element,
                publicSurface: true
              }
            ]
          : []
    };
  }
  if (ts.isNewExpression(container)) {
    return {
      isConcrete: true,
      values: classInstanceInitializers(container, context, true)
        .filter((entry) => entry.name === memberName)
        .map((entry) => ({ value: entry.value, publicSurface: true }))
    };
  }
  if (ts.isIdentifier(container)) {
    const initializers = symbolInitializers(container, context, traversal);
    if (initializers.length === 0) return { isConcrete: false, values: [] };
    const materializations = initializers.map((initializer) =>
      memberMaterialization(initializer, memberName, context, traversal)
    );
    return {
      isConcrete: materializations.every((materialization) => materialization.isConcrete),
      values: materializations.flatMap((materialization) => materialization.values)
    };
  }
  if (ts.isPropertyAccessExpression(container)) {
    if (ts.isPrivateIdentifier(container.name)) {
      if (traversal !== 'public-surface') return { isConcrete: false, values: [] };
      const materializations = privateMemberInitializers(
        container.expression,
        container.name.text,
        context,
        traversal
      ).map((initializer) => memberMaterialization(initializer, memberName, context, traversal));
      return {
        isConcrete: materializations.every((materialization) => materialization.isConcrete),
        values: materializations.flatMap((materialization) => materialization.values)
      };
    }
    const outer = memberMaterialization(
      container.expression,
      container.name.text,
      context,
      traversal
    );
    if (!outer.isConcrete) return { isConcrete: false, values: [] };
    const materializations = outer.values.map((initializer) =>
      memberMaterialization(
        initializer.value,
        memberName,
        context,
        initializer.publicSurface ? 'public-surface' : traversal
      )
    );
    return {
      isConcrete: materializations.every((materialization) => materialization.isConcrete),
      values: materializations.flatMap((materialization) => materialization.values)
    };
  }
  if (container.kind === ts.SyntaxKind.ThisKeyword) {
    return {
      isConcrete: true,
      values: thisPropertyInitializers(container, context)
        .filter((entry) => entry.name === memberName)
        .map((entry) => ({ value: entry.value, publicSurface: true }))
    };
  }
  return { isConcrete: false, values: [] };
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
    if (name !== undefined) values.set(name, [{ value: member.initializer }]);
  }
  for (const member of classNode.members) {
    if (!ts.isGetAccessorDeclaration(member) || !isPublicInstanceMember(member)) continue;
    const name = memberName(member.name, context);
    const returned = returnExpressions(member);
    if (name !== undefined && returned.length > 0) {
      values.set(
        name,
        returned.map((value) => ({ value }))
      );
    }
  }
  for (const member of classNode.members) {
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    for (const assignment of constructorAssignments(member, context.freeze)) {
      updateConstructorValues(values, assignment, (value) => ({ value }));
    }
  }
  return [...values].flatMap(([name, entries]) => entries.map((entry) => ({ name, ...entry })));
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
        if (name !== undefined) values.set(name, [{ value: member.initializer }]);
      }
      if (includeGetters && ts.isGetAccessorDeclaration(member) && isPublicInstanceMember(member)) {
        const name = memberName(member.name, context);
        const returned = returnExpressions(member);
        if (name !== undefined && returned.length > 0) {
          values.set(
            name,
            returned.map((value) => ({ value }))
          );
        }
      }
      if (ts.isConstructorDeclaration(member) && member.body) {
        for (const assignment of constructorAssignments(member, context.freeze)) {
          updateConstructorValues(values, assignment, (value) => ({ value }));
        }
      }
    }
  }
  return [...values].flatMap(([name, entries]) => entries.map((entry) => ({ name, ...entry })));
}

/** Getter provenance may inspect a private backing field without treating it as directly published. */
function privateMemberInitializers(
  containerExpression,
  memberName,
  context,
  traversal = 'publication'
) {
  const container = unwrapExpression(containerExpression);
  if (traversal !== 'public-surface' || !resolvesToLiteralThis(container, context)) return [];
  const classNode = nearestClass(container) ?? nearestClass(context.freeze);
  if (!classNode) return [];
  const values = new Map();
  for (const member of classNode.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isPrivateIdentifier(member.name) &&
      member.initializer
    ) {
      values.set(member.name.text, [member.initializer]);
    }
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    for (const assignment of constructorAssignments(member, context.freeze, true)) {
      updateConstructorValues(values, assignment, (value) => value);
    }
  }
  return values.get(memberName) ?? [];
}

/** A public accessor may retain a lexical alias of its receiver, never an arbitrary lookalike. */
function resolvesToLiteralThis(expression, context, seenSymbols = new Set()) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(value)) {
    return memberMaterialization(
      value.expression,
      value.name.text,
      context,
      'public-surface'
    ).values.some((entry) => resolvesToLiteralThis(entry.value, context, seenSymbols));
  }
  if (!ts.isIdentifier(value)) return false;
  const symbol = symbolFor(value, context);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return symbolInitializers(value, context, 'public-surface').some((initializer) =>
    resolvesToLiteralThis(initializer, context, seenSymbols)
  );
}

function constructorAssignments(constructor, freeze, includePrivate = false) {
  const results = [];
  const freezeStart =
    constructor.pos <= freeze.pos && freeze.end <= constructor.end ? freeze.pos : Infinity;
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      (includePrivate || !ts.isPrivateIdentifier(node.left.name)) &&
      node.getStart() < freezeStart
    ) {
      results.push({
        name: node.left.name.text,
        value: node.right,
        unconditional:
          isUnconditionalConstructorWrite(node, constructor.body) &&
          !hasEarlierSuccessfulConstructorBypass(constructor.body, node)
      });
    }
    if (node !== constructor && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(constructor.body, visit);
  return results;
}

/** A throw never produces an instance; an earlier transfer past the write makes it conditional. */
function hasEarlierSuccessfulConstructorBypass(body, assignment) {
  let hasBypass = false;
  const assignmentStart = assignment.getStart();
  const visit = (node) => {
    if (hasBypass || node.getStart() >= assignmentStart) return;
    if (ts.isReturnStatement(node)) {
      hasBypass = true;
      return;
    }
    if (
      (ts.isBreakStatement(node) && transferCanBypassAssignment(node, assignment, 'break')) ||
      (ts.isContinueStatement(node) && transferCanBypassAssignment(node, assignment, 'continue'))
    ) {
      hasBypass = true;
      return;
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return hasBypass;
}

function transferCanBypassAssignment(statement, assignment, kind) {
  const target = transferTarget(statement, kind);
  return target !== undefined && isAncestor(target, assignment);
}

function transferTarget(statement, kind) {
  const label = statement.label?.text;
  for (let current = statement.parent; current; current = current.parent) {
    if (label !== undefined) {
      if (ts.isLabeledStatement(current) && current.label.text === label) return current;
      continue;
    }
    if (kind === 'break' && (isIterationStatement(current) || ts.isSwitchStatement(current))) {
      return current;
    }
    if (kind === 'continue' && isIterationStatement(current)) return current;
  }
  return undefined;
}

function isIterationStatement(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isAncestor(ancestor, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/** A conditional write can supplement an initializer but cannot erase it on every construction path. */
function updateConstructorValues(values, assignment, createEntry) {
  const entry = createEntry(assignment.value);
  const previous = values.get(assignment.name) ?? [];
  values.set(assignment.name, assignment.unconditional ? [entry] : [...previous, entry]);
}

function isUnconditionalConstructorWrite(node, body) {
  for (let current = node.parent; current && current !== body; current = current.parent) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return false;
    }
  }
  return true;
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

function isDetachedTypedArrayCopy(expression, context) {
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;
  const { expression: receiver, name } = expression.expression;
  const kind = mutableBuiltinTypeKind(
    context.checker.getTypeAtLocation(receiver),
    context,
    new Set()
  );
  return name.text === 'slice' && kind !== undefined && TYPED_ARRAYS.has(kind);
}

function standardBuiltinKind(symbol) {
  if (!symbol || !hasStandardLibraryDeclaration(symbol)) return undefined;
  const name = symbol.getName();
  return MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name) ? name : undefined;
}

function hasStandardLibraryDeclaration(symbol) {
  return symbol.declarations?.some(isStandardLibraryDeclaration) ?? false;
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
  for (const element of tupleElementTypes(type, context)) {
    const elementPath = appendTupleElementPath(propertyPath, element.index);
    const kind = mutableBuiltinTypeKind(element.type, context, new Set());
    if (kind) emitExposure(elementPath, kind, context, results, emitted);
    else collectTypeProperties(element.type, elementPath, context, results, emitted, seen);
  }
  for (const elementType of standardArrayElementTypes(type, context)) {
    const kind = mutableBuiltinTypeKind(elementType, context, new Set());
    if (kind) emitExposure(appendIndexPath(propertyPath), kind, context, results, emitted);
    else
      collectTypeProperties(
        elementType,
        appendIndexPath(propertyPath),
        context,
        results,
        emitted,
        seen
      );
  }
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

function standardArrayElementTypes(type, context, seen = new Set()) {
  if (!type || seen.has(type)) return [];
  seen.add(type);
  if (tupleElementTypes(type, context).length > 0) return [];
  const elements = [];
  const typeArguments = typeArgumentsOf(type, context);
  const candidates = [type, type.target, context.checker.getApparentType(type)];
  try {
    candidates.push(...(context.checker.getBaseTypes(type) ?? []));
  } catch {
    // Primitive and non-object types do not have base types.
  }
  for (const candidate of candidates) {
    if (!candidate || (candidate !== type && seen.has(candidate))) continue;
    if (candidate !== type) seen.add(candidate);
    const symbol = resolvedSymbol(candidate.aliasSymbol ?? candidate.getSymbol(), context);
    if (
      symbol &&
      STANDARD_ARRAY_TYPES.has(symbol.getName()) &&
      hasStandardLibraryDeclaration(symbol)
    ) {
      if (candidate === type.target) elements.push(...typeArguments);
      try {
        for (const indexInfo of context.checker.getIndexInfosOfType(candidate)) {
          elements.push(indexInfo.type);
        }
      } catch {
        // A malformed or unresolved library type has no reliable element edge.
      }
      continue;
    }
    elements.push(...standardArrayElementTypes(candidate, context, seen));
  }
  return elements;
}

function tupleElementTypes(type, context, seen = new Set()) {
  if (!type || seen.has(type)) return [];
  seen.add(type);
  const candidates = [type, type.target, context.checker.getApparentType(type)];
  for (const candidate of candidates) {
    if (!candidate || (candidate !== type && seen.has(candidate))) continue;
    if (candidate !== type) seen.add(candidate);
    if (context.checker.isTupleType(candidate)) {
      const target = candidate.target ?? candidate;
      const typeArguments = typeArgumentsOf(type, context);
      const elements =
        typeArguments.length > 0 ? typeArguments : typeArgumentsOf(candidate, context);
      const flags = target.elementFlags ?? [];
      return elements.map((element, index) => ({
        type: element,
        index: flags[index] & ts.ElementFlags.Rest ? undefined : index
      }));
    }
  }
  return [];
}

function typeArgumentsOf(type, context) {
  try {
    return context.checker.getTypeArguments(type);
  } catch {
    return [];
  }
}

function isRuntimePropertyDeclaration(declaration) {
  if (ts.isPropertySignature(declaration)) return true;
  if (ts.isPropertyDeclaration(declaration)) return hasRuntimeFieldEmit(declaration);
  return ts.isGetAccessorDeclaration(declaration) && isPublicInstanceMember(declaration);
}

function isPublicInstanceMember(member) {
  return (
    !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword) &&
    !ts.isPrivateIdentifier(member.name)
  );
}

function hasRuntimeFieldEmit(member) {
  if (
    hasModifier(member, ts.SyntaxKind.DeclareKeyword) ||
    hasModifier(member, ts.SyntaxKind.AbstractKeyword)
  ) {
    return false;
  }
  const classNode = member.parent;
  return !(
    (ts.isClassDeclaration(classNode) || ts.isClassExpression(classNode)) &&
    hasModifier(classNode, ts.SyntaxKind.DeclareKeyword)
  );
}

function appendIndexPath(prefix) {
  return prefix ? `${prefix}[index]` : '[index]';
}

function appendTupleElementPath(prefix, index) {
  return index === undefined ? appendIndexPath(prefix) : `${prefix}[${index}]`;
}

function symbolInitializers(identifier, context, traversal = 'publication') {
  const symbol = symbolFor(identifier, context);
  if (!symbol || context.resolvingSymbols.has(symbol)) return [];
  context.resolvingSymbols.add(symbol);
  try {
    return initializerForSymbol(symbol, context, new Set(), traversal);
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

function initializerForSymbol(symbol, context, seen = new Set(), traversal = 'publication') {
  if (seen.has(symbol)) return [];
  seen.add(symbol);
  const results = [];
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
      results.push(declaration.initializer);
    if (ts.isPropertyDeclaration(declaration) && declaration.initializer)
      results.push(declaration.initializer);
    if (ts.isBindingElement(declaration)) {
      results.push(...bindingElementInitializers(declaration, context, traversal));
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(declaration);
      if (valueSymbol) results.push(...initializerForSymbol(valueSymbol, context, seen, traversal));
    }
  }
  return results;
}

function bindingElementInitializers(element, context, traversal = 'publication') {
  const pattern = element.parent;
  const declaration = pattern.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return [];
  if (ts.isObjectBindingPattern(pattern)) {
    if (element.dotDotDotToken) {
      return objectRestBindingInitializers(
        pattern,
        element,
        declaration.initializer,
        context,
        traversal
      );
    }
    const name = element.propertyName
      ? memberName(element.propertyName, context)
      : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
    const sourceValues =
      name === undefined
        ? []
        : memberMaterialization(declaration.initializer, name, context, traversal).values.map(
            (entry) => entry.value
          );
    return appendBindingFallback(element, sourceValues, context);
  }
  if (ts.isArrayBindingPattern(pattern)) {
    const index = pattern.elements.indexOf(element);
    const sourceValues =
      index < 0
        ? []
        : iterableElements(declaration.initializer, context, traversal).slice(index, index + 1);
    return appendBindingFallback(element, sourceValues, context);
  }
  return [];
}

function objectRestBindingInitializers(pattern, element, source, context, traversal) {
  const excluded = new Set(
    pattern.elements
      .filter((binding) => binding !== element && !binding.dotDotDotToken)
      .map((binding) => bindingPropertyName(binding, context))
      .filter((name) => name !== undefined)
  );
  return materializeObjectProperties(source, context, traversal).flatMap(([name, values]) =>
    excluded.has(name)
      ? []
      : values.map((value) =>
          ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(name), value)
          ])
        )
  );
}

function bindingPropertyName(element, context) {
  return element.propertyName
    ? memberName(element.propertyName, context)
    : ts.isIdentifier(element.name)
      ? element.name.text
      : undefined;
}

function appendBindingFallback(element, sourceValues, context) {
  if (!element.initializer || !bindingMayUseInitializer(sourceValues, context)) return sourceValues;
  return [...sourceValues, element.initializer];
}

function bindingMayUseInitializer(sourceValues, context) {
  return sourceValues.length === 0 || sourceValues.some((value) => mayBeUndefined(value, context));
}

function mayBeUndefined(expression, context, seen = new Set()) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.VoidExpression) return true;
  const type = context.checker.getTypeAtLocation(value);
  if (!type || seen.has(type)) return false;
  seen.add(type);
  return (
    (type.flags &
      (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
      0 || type.types?.some((part) => mayBeUndefinedType(part, seen))
  );
}

function mayBeUndefinedType(type, seen) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  return (
    (type.flags &
      (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
      0 || type.types?.some((part) => mayBeUndefinedType(part, seen))
  );
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
  if (
    ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property) ||
    ts.isGetAccessorDeclaration(property)
  ) {
    return memberName(property.name, context);
  }
  return undefined;
}

function propertyValues(property) {
  if (ts.isPropertyAssignment(property)) return [property.initializer];
  if (ts.isShorthandPropertyAssignment(property)) return [property.name];
  return ts.isGetAccessorDeclaration(property) ? returnExpressions(property) : [];
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

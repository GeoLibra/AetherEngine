import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');

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
/**
 * Every exception needs an exact freeze call, property path, runtime kind, and a review rationale.
 * This list is intentionally empty: published nested mutable built-ins have enforcing facades or
 * detached accessors, while private typed arrays never appear as fields of a frozen publication.
 */
const NESTED_MUTABLE_ALLOWLIST: readonly ReviewedNestedMutableExposure[] = Object.freeze([]);

interface NestedMutableExposure {
  readonly location: string;
  readonly propertyPath: string;
  readonly kind: string;
}

interface ReviewedNestedMutableExposure extends NestedMutableExposure {
  readonly rationale: string;
}

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && path.endsWith('.ts')
        ? [path]
        : [];
  });
}

function isFreezeCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'freeze'
  );
}

function sourceLocation(path: string, source: ts.SourceFile, node: ts.Node): string {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const displayPath =
    path === 'snippet.ts' ? path : relative(SOURCE_ROOT, path).split(sep).join('/');
  return `${displayPath}:${position.line + 1}:${position.character + 1}`;
}

function isNamedEmptySnapshot(node: ts.CallExpression): boolean {
  let expression: ts.Expression = node;
  while (
    ts.isAsExpression(expression.parent) ||
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  const declaration = expression.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== expression ||
    !ts.isIdentifier(declaration.name) ||
    !/^[A-Z][A-Z0-9_]*$/.test(declaration.name.text)
  ) {
    return false;
  }
  const declarationList = declaration.parent;
  return (
    ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(declarationList.parent) &&
    ts.isSourceFile(declarationList.parent.parent)
  );
}

function findFreezeCalls(
  matches: (argument: ts.Expression, node: ts.CallExpression) => boolean
): string[] {
  const results: string[] = [];
  for (const path of sourceFiles()) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node): void => {
      if (isFreezeCall(node) && node.arguments.length === 1 && matches(node.arguments[0]!, node)) {
        results.push(sourceLocation(path, source, node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return results;
}

function findInlineEmptySnapshots(sourceText: string): string[] {
  const source = ts.createSourceFile('snippet.ts', sourceText, ts.ScriptTarget.Latest, true);
  const results: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      isFreezeCall(node) &&
      node.arguments.length === 1 &&
      ts.isArrayLiteralExpression(node.arguments[0]!) &&
      node.arguments[0]!.elements.length === 0 &&
      !isNamedEmptySnapshot(node)
    ) {
      results.push(sourceLocation('snippet.ts', source, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}

function isNewExpressionFor(names: ReadonlySet<string>) {
  return (argument: ts.Expression): boolean =>
    ts.isNewExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    names.has(argument.expression.text);
}

function findNestedMutableExposures(sourceText: string): NestedMutableExposure[] {
  const source = ts.createSourceFile('snippet.ts', sourceText, ts.ScriptTarget.Latest, true);
  return findNestedMutableExposuresInSource('snippet.ts', source, undefined);
}

function findProductionNestedMutableExposures(): NestedMutableExposure[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true
  };
  const paths = sourceFiles();
  const program = ts.createProgram(paths, compilerOptions);
  const checker = program.getTypeChecker();
  return paths.flatMap((path) => {
    const source = program.getSourceFile(path);
    return source ? findNestedMutableExposuresInSource(path, source, checker) : [];
  });
}

function findNestedMutableExposuresInSource(
  path: string,
  source: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): NestedMutableExposure[] {
  const declarations = new Map<string, ts.Expression>();
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);

  const results: NestedMutableExposure[] = [];
  const visit = (node: ts.Node): void => {
    if (
      isFreezeCall(node) &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0]!)
    ) {
      collectMutableProperties(
        node.arguments[0]!,
        '',
        node,
        path,
        source,
        checker,
        declarations,
        results
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}

function collectMutableProperties(
  object: ts.ObjectLiteralExpression,
  prefix: string,
  freeze: ts.CallExpression,
  path: string,
  source: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  declarations: ReadonlyMap<string, ts.Expression>,
  results: NestedMutableExposure[]
): void {
  for (const property of object.properties) {
    const name = propertyName(property);
    const value = propertyValue(property);
    if (!name || !value) continue;
    const propertyPath = prefix ? `${prefix}.${name}` : name;
    if (ts.isObjectLiteralExpression(value)) {
      collectMutableProperties(
        value,
        propertyPath,
        freeze,
        path,
        source,
        checker,
        declarations,
        results
      );
      continue;
    }
    const kind = mutableBuiltinKind(value, checker, declarations, new Set());
    if (kind)
      results.push({
        location: sourceLocation(path, source, freeze),
        propertyPath,
        kind
      });
  }
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
  }
  return undefined;
}

function propertyValue(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function mutableBuiltinKind(
  expression: ts.Expression,
  checker: ts.TypeChecker | undefined,
  declarations: ReadonlyMap<string, ts.Expression>,
  seen: Set<ts.Expression>
): string | undefined {
  const value = unwrapExpression(expression);
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (ts.isNewExpression(value) && ts.isIdentifier(value.expression)) {
    const name = value.expression.text;
    if (MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name)) return name;
  }
  const typedName = checker && mutableBuiltinTypeName(checker, value);
  if (typedName) return typedName;
  if (ts.isIdentifier(value)) {
    const initializer = declarations.get(value.text);
    if (initializer) return mutableBuiltinKind(initializer, checker, declarations, seen);
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isAsExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function mutableBuiltinTypeName(
  checker: ts.TypeChecker,
  expression: ts.Expression
): string | undefined {
  const type = checker.getApparentType(checker.getTypeAtLocation(expression));
  const symbols =
    type.isUnion() || type.isIntersection()
      ? type.types.map((part) => part.getSymbol())
      : [type.getSymbol()];
  for (const symbol of symbols) {
    const name = symbol?.getName();
    if (name && (MUTABLE_BUILT_INS.has(name) || TYPED_ARRAYS.has(name))) return name;
  }
  return undefined;
}

describe('Object.freeze governance', () => {
  test('allows only module-owned named empty snapshots', () => {
    expect(findInlineEmptySnapshots('const NO_VALUES = Object.freeze([]);')).toEqual([]);
    expect(
      findInlineEmptySnapshots('function build() { const NO_VALUES = Object.freeze([]); }')
    ).toHaveLength(1);
  });

  test('does not freeze inline empty arrays', () => {
    expect(
      findFreezeCalls(
        (argument, node) =>
          ts.isArrayLiteralExpression(argument) &&
          argument.elements.length === 0 &&
          !isNamedEmptySnapshot(node)
      )
    ).toEqual([]);
  });

  test('does not directly freeze mutable built-in constructors', () => {
    expect(findFreezeCalls(isNewExpressionFor(MUTABLE_BUILT_INS))).toEqual([]);
  });

  test('does not directly freeze typed-array constructors', () => {
    expect(findFreezeCalls(isNewExpressionFor(TYPED_ARRAYS))).toEqual([]);
  });

  test('detects nested mutable collections and aliases hidden by a frozen outer shell', () => {
    expect(
      findNestedMutableExposures(`
        const mapAlias = new Map<string, number>();
        const typedAlias = new Float32Array(4);
        Object.freeze({
          directSet: new Set<string>(),
          nested: { mapAlias, typedAlias }
        });
      `)
    ).toEqual([
      { location: 'snippet.ts:4:9', propertyPath: 'directSet', kind: 'Set' },
      { location: 'snippet.ts:4:9', propertyPath: 'nested.mapAlias', kind: 'Map' },
      { location: 'snippet.ts:4:9', propertyPath: 'nested.typedAlias', kind: 'Float32Array' }
    ]);
  });

  test('requires reviewed allowlist entries for published nested mutable built-ins', () => {
    expect(findProductionNestedMutableExposures()).toEqual(
      NESTED_MUTABLE_ALLOWLIST.map(({ rationale: _rationale, ...exposure }) => exposure)
    );
  });
});

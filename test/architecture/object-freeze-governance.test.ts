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
  return `${relative(SOURCE_ROOT, path).split(sep).join('/')}:${position.line + 1}:${position.character + 1}`;
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
  return (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
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

function isNewExpressionFor(names: ReadonlySet<string>) {
  return (argument: ts.Expression): boolean =>
    ts.isNewExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    names.has(argument.expression.text);
}

describe('Object.freeze governance', () => {
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
});

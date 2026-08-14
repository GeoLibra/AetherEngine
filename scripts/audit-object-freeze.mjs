import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

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

function sourceFiles(directory = SOURCE_ROOT) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : entry.isFile() && path.endsWith('.ts')
          ? [path]
          : [];
    })
    .sort();
}

function sourcePath(path) {
  return relative(process.cwd(), path).split(sep).join('/');
}

function isFreeze(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === 'Object' &&
    node.expression.name.text === 'freeze'
  );
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return '<anonymous>';
}

function nearestFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function argumentIsFunctionParameter(argument, enclosingFunction) {
  if (!enclosingFunction || !ts.isIdentifier(argument)) return false;
  return enclosingFunction.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === argument.text
  );
}

function freezeCategory(argument) {
  if (ts.isArrayLiteralExpression(argument) && argument.elements.length === 0)
    return 'inline-empty-array';
  if (ts.isNewExpression(argument) && ts.isIdentifier(argument.expression)) {
    if (MUTABLE_BUILT_INS.has(argument.expression.text)) return 'mutable-built-in';
    if (TYPED_ARRAYS.has(argument.expression.text)) return 'typed-array';
  }
  return undefined;
}

function auditFile(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  if (source.parseDiagnostics.length > 0) {
    const diagnostics = source.parseDiagnostics.map((diagnostic) => {
      const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `${sourcePath(path)}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    throw new Error(diagnostics.join('\n'));
  }

  const calls = [];
  const visit = (node) => {
    if (isFreeze(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const enclosingFunction = nearestFunction(node);
      calls.push({
        path: sourcePath(path),
        line: position.line + 1,
        column: position.character + 1,
        argumentKind: ts.SyntaxKind[argument.kind],
        enclosingFunction: enclosingFunction ? functionName(enclosingFunction) : null,
        argumentIsFunctionParameter: argumentIsFunctionParameter(argument, enclosingFunction),
        category: freezeCategory(argument) ?? null
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

try {
  const calls = sourceFiles().flatMap(auditFile);
  const byArgumentKind = Object.fromEntries(
    [...new Set(calls.map((call) => call.argumentKind))]
      .sort()
      .map((kind) => [kind, calls.filter((call) => call.argumentKind === kind).length])
  );
  const banned = Object.fromEntries(
    ['inline-empty-array', 'mutable-built-in', 'typed-array'].map((category) => [
      category,
      calls.filter((call) => call.category === category)
    ])
  );
  process.stdout.write(
    `${JSON.stringify({ total: calls.length, byArgumentKind, banned, calls }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(
    `Object.freeze audit failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { collectFrozenMutableExposures } from './object-freeze-traversal.mjs';

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

export function sourceFiles(directory) {
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

export function analyzeFreezeSource(sourceText, path = 'snippet.ts', sourceRoot = process.cwd()) {
  const program = createSnippetProgram(sourceText, path);
  const source = program.getSourceFile(path);
  if (!source) throw new Error(`Cannot analyze missing source "${path}".`);
  return analyzeSource(path, source, program.getTypeChecker(), sourceRoot);
}

export function analyzeProductionFreeze(sourceRoot = join(process.cwd(), 'src')) {
  const paths = sourceFiles(sourceRoot);
  const program = ts.createProgram(paths, compilerOptions());
  const checker = program.getTypeChecker();
  return paths.flatMap((path) => {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Cannot analyze missing source "${path}".`);
    return analyzeSource(path, source, checker, sourceRoot);
  });
}

export function auditProductionFreeze(sourceRoot = join(process.cwd(), 'src')) {
  const calls = analyzeProductionFreeze(sourceRoot);
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
  const nestedMutableBuiltIns = calls.flatMap((call) =>
    call.nestedMutableBuiltIns.map((exposure) => ({
      path: call.path,
      line: call.line,
      column: call.column,
      ...exposure
    }))
  );
  return { total: calls.length, byArgumentKind, banned, nestedMutableBuiltIns, calls };
}

function compilerOptions() {
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true
  };
}

function createSnippetProgram(sourceText, path) {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const canonicalPath = ts.sys.resolvePath(path);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (ts.sys.resolvePath(fileName) === canonicalPath) {
      return ts.createSourceFile(fileName, sourceText, languageVersion, true);
    }
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.readFile = (fileName) =>
    ts.sys.resolvePath(fileName) === canonicalPath ? sourceText : ts.sys.readFile(fileName);
  return ts.createProgram([path], options, host);
}

function analyzeSource(path, source, checker, sourceRoot) {
  assertParseable(path, source);
  const calls = [];
  const visit = (node) => {
    if (isFreezeCall(node) && node.arguments.length === 1) {
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
        category: freezeCategory(argument, node) ?? null,
        nestedMutableBuiltIns: collectFrozenMutableExposures(
          argument,
          node,
          path,
          source,
          checker,
          sourceRoot
        )
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function assertParseable(path, source) {
  if (source.parseDiagnostics.length === 0) return;
  const diagnostics = source.parseDiagnostics.map((diagnostic) => {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${sourcePath(path)}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
  throw new Error(diagnostics.join('\n'));
}

function isFreezeCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'freeze'
  );
}

function freezeCategory(argument, freeze) {
  if (
    ts.isArrayLiteralExpression(argument) &&
    argument.elements.length === 0 &&
    !isNamedEmptySnapshot(freeze)
  ) {
    return 'inline-empty-array';
  }
  if (ts.isNewExpression(argument) && ts.isIdentifier(argument.expression)) {
    if (MUTABLE_BUILT_INS.has(argument.expression.text)) return 'mutable-built-in';
    if (TYPED_ARRAYS.has(argument.expression.text)) return 'typed-array';
  }
  return undefined;
}

function isNamedEmptySnapshot(node) {
  let expression = node;
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

function sourcePath(path) {
  return relative(process.cwd(), path).split(sep).join('/');
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
  return (
    enclosingFunction !== undefined &&
    ts.isIdentifier(argument) &&
    enclosingFunction.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === argument.text
    )
  );
}

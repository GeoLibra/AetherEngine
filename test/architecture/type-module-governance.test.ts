import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');

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

function sourcePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join('/');
}

function isLegacyTypeFile(path: string): boolean {
  const name = path.split('/').at(-1)!;
  return !isTypeModuleFile(path) && (name === 'types.ts' || name.endsWith('-types.ts'));
}

function isTypeModuleFile(path: string): boolean {
  const relativePath = sourcePath(path);
  return relativePath.startsWith('types/') || relativePath.includes('/types/');
}

function isTypeIndex(path: string): boolean {
  const relativePath = sourcePath(path);
  return relativePath === 'types/index.ts' || relativePath.endsWith('/types/index.ts');
}

function runtimeStatements(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  return source.statements
    .filter((statement) => {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
        return false;
      if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly !== true;
      if (ts.isExportDeclaration(statement)) return statement.isTypeOnly !== true;
      if (ts.isVariableStatement(statement)) {
        return (statement.modifiers ?? []).every(
          (modifier) => modifier.kind !== ts.SyntaxKind.DeclareKeyword
        );
      }
      return !ts.isEmptyStatement(statement);
    })
    .map((statement) => statement.getText(source));
}

function typeIndexViolations(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  return source.statements
    .filter(
      (statement) =>
        !ts.isEmptyStatement(statement) &&
        (!ts.isExportDeclaration(statement) ||
          statement.isTypeOnly !== true ||
          statement.exportClause === undefined ||
          !ts.isNamedExports(statement.exportClause))
    )
    .map((statement) => statement.getText(source));
}

function typeContractLeafImports(path: string, text = readFileSync(path, 'utf8')): string[] {
  if (isTypeModuleFile(path)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !isTypeContractImport(statement)) return [];
    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    return moduleSpecifier !== undefined && importsTypeLeaf(moduleSpecifier)
      ? [moduleSpecifier]
      : [];
  });
}

function isTypeContractImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function importsTypeLeaf(moduleSpecifier: string): boolean {
  const segments = moduleSpecifier.split('/');
  const typesIndex = segments.lastIndexOf('types');
  return typesIndex >= 0 && typesIndex < segments.length - 1;
}

describe('type module governance', () => {
  test('stores shared type modules below local types directories', () => {
    expect(sourceFiles().map(sourcePath).filter(isLegacyTypeFile)).toEqual([]);
  });

  test('does not allow a global src/types directory', () => {
    expect(existsSync(join(SOURCE_ROOT, 'types'))).toBe(false);
  });

  test('keeps type modules runtime-free', () => {
    const violations = sourceFiles()
      .filter((path) => isLegacyTypeFile(path) || isTypeModuleFile(path))
      .flatMap((path) =>
        runtimeStatements(path).map((statement) => `${sourcePath(path)}: ${statement}`)
      );
    expect(violations).toEqual([]);
  });

  test('uses explicit type-only exports from type indexes', () => {
    const violations = sourceFiles()
      .filter(isTypeIndex)
      .flatMap((path) =>
        typeIndexViolations(path).map((statement) => `${sourcePath(path)}: ${statement}`)
      );
    expect(violations).toEqual([]);
  });

  test('requires implementation type imports to use a local types entry', () => {
    const violations = sourceFiles().flatMap((path) =>
      typeContractLeafImports(path).map(
        (moduleSpecifier) => `${sourcePath(path)}: ${moduleSpecifier}`
      )
    );
    expect(violations).toEqual([]);
  });

  test('recognizes only type-contract leaf imports outside type directories', () => {
    const implementation = join(SOURCE_ROOT, 'platform', 'browser-graphics-error.ts');
    const typeModule = join(SOURCE_ROOT, 'platform', 'types', 'browser-graphics-types.ts');

    expect(
      typeContractLeafImports(
        implementation,
        "import type { Contract } from './types/browser-graphics-types';"
      )
    ).toEqual(['./types/browser-graphics-types']);
    expect(
      typeContractLeafImports(implementation, "import type { Contract } from './types';")
    ).toEqual([]);
    expect(
      typeContractLeafImports(
        implementation,
        "import { type Contract } from './types/contract-types';"
      )
    ).toEqual(['./types/contract-types']);
    expect(
      typeContractLeafImports(
        implementation,
        "import type { Contract } from './browser-graphics-types';"
      )
    ).toEqual([]);
    expect(
      typeContractLeafImports(typeModule, "import type { Contract } from './other-contract-types';")
    ).toEqual([]);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const EXAMPLE_SOURCE = join(process.cwd(), 'examples/react-vite-ts/src');

describe('React Vite public API example', () => {
  test('uses only the package public API and keeps renderer internals out of scene code', () => {
    const files = sourceFiles(EXAMPLE_SOURCE);
    expect(files.map((file) => relative(process.cwd(), file))).toEqual([
      'examples/react-vite-ts/src/App.tsx',
      'examples/react-vite-ts/src/aether-scene.ts',
      'examples/react-vite-ts/src/anti-aliasing.ts',
      'examples/react-vite-ts/src/demand-driven-runner.ts',
      'examples/react-vite-ts/src/demos/csm-box/CsmBoxDemo.tsx',
      'examples/react-vite-ts/src/demos/damaged-helmet/DamagedHelmetDemo.tsx',
      'examples/react-vite-ts/src/demos/damaged-helmet/damaged-helmet-scene.ts',
      'examples/react-vite-ts/src/demos/registry.ts',
      'examples/react-vite-ts/src/demos/types.ts',
      'examples/react-vite-ts/src/main.tsx',
      'examples/react-vite-ts/src/scene-host.ts'
    ]);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const imports = sourceFile.statements.filter(ts.isImportDeclaration);
      for (const declaration of imports) {
        const specifier = declaration.moduleSpecifier;
        if (ts.isStringLiteral(specifier)) {
          expect(specifier.text).not.toMatch(/(?:^|\/)src(?:\/|$)/);
          if (file.endsWith('aether-scene.ts') && !specifier.text.startsWith('.'))
            expect(specifier.text).toBe('@aether/engine');
        }
      }

      expect(source).not.toMatch(/\b(?:wgsl|glsl)\b/i);
      expect(source).not.toMatch(
        /\b(?:createShaderModule|createRenderPipeline|createBindGroup|createCommandEncoder|beginRenderPass|PreparedDrawPacket)\b/
      );
      expect(source).not.toMatch(/\b(?:pipeline|bindGroup)(?:Layout)?\s*:/);
      visit(sourceFile, (node) => {
        if (ts.isIfStatement(node))
          expect(node.expression.getText(sourceFile)).not.toMatch(/webgpu|webgl2/i);
        if (ts.isConditionalExpression(node))
          expect(node.condition.getText(sourceFile)).not.toMatch(/webgpu|webgl2/i);
      });
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(directory, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(directory, entry.name)]
          : []
    )
    .sort();
}

function visit(node: ts.Node, assertion: (node: ts.Node) => void): void {
  assertion(node);
  node.forEachChild((child) => visit(child, assertion));
}

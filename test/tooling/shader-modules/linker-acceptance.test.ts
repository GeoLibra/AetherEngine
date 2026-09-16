import { describe, expect, it } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDependencyClosure,
  linkStrictWgsl,
  remapLinkedDiagnostic,
  type ModuleSourceLoader
} from '../../../tools/shader-cooker/modules';
import {
  NativeWgslCooker,
  NativeCookerError
} from '../../../tools/shader-cooker/native-wgsl-cooker';

const FIXTURES_ROOT = resolve(import.meta.dirname, 'fixtures');

const fileSystemLoader: ModuleSourceLoader = {
  async loadSource(uri: string): Promise<string | undefined> {
    try {
      return await readFile(uri, 'utf-8');
    } catch {
      return undefined;
    }
  }
};

const cooker = new NativeWgslCooker();

async function cookLinkedSource(source: string, sourceUri: string) {
  const tempPath = resolve(
    tmpdir(),
    `aether-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wgsl`
  );
  await writeFile(tempPath, source, 'utf-8');
  try {
    const artifact = await cooker.cook({ sourcePath: tempPath, sourceUri });
    return { status: 'ok' as const, artifact };
  } catch (error) {
    if (error instanceof NativeCookerError) {
      return {
        status: 'error' as const,
        error,
        diagnostics: [{ line: error.line, column: error.column, message: error.message }]
      };
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

describe('Shader Module Linker Acceptance Against Native Naga Cooker', () => {
  it('Fixture 1 & 5: Diamond dependency compiles cleanly with Naga', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    const result = await cookLinkedSource(linked.standardWgsl, 'asset://test/diamond.wgsl');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const entryPointNames = result.artifact.entryPoints.map((ep) => ep.name);
      expect(entryPointNames).toContain('fs_main');
    }
  });

  it('Fixture 2: Shared UV and coverage compiles for both Lit and Shadow roots', async () => {
    const litRoot = resolve(FIXTURES_ROOT, 'uv-coverage/lit_root.wgsl');
    const shadowRoot = resolve(FIXTURES_ROOT, 'uv-coverage/shadow_root.wgsl');

    const litClosure = await resolveDependencyClosure(litRoot, fileSystemLoader);
    const shadowClosure = await resolveDependencyClosure(shadowRoot, fileSystemLoader);

    const litLinked = linkStrictWgsl(litClosure);
    const shadowLinked = linkStrictWgsl(shadowClosure);

    const litResult = await cookLinkedSource(
      litLinked.standardWgsl,
      'asset://test/uv-coverage-lit.wgsl'
    );
    const shadowResult = await cookLinkedSource(
      shadowLinked.standardWgsl,
      'asset://test/uv-coverage-shadow.wgsl'
    );

    expect(litResult.status).toBe('ok');
    expect(shadowResult.status).toBe('ok');
  });

  it('Fixture 3: Shared BRDF functions compile and emit valid GLSL ES', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'brdf/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    const result = await cookLinkedSource(linked.standardWgsl, 'asset://test/brdf.wgsl');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.artifact.modules.glslEs300).toBeDefined();
    }
  });

  it('Fixture 4: Bindings and struct layouts reflect accurately', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'bindings/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    const result = await cookLinkedSource(linked.standardWgsl, 'asset://test/bindings.wgsl');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const binding = result.artifact.bindings.find((b) => b.name === 'materialParams');
      expect(binding).toBeDefined();
      expect(binding?.binding).toBe(0);
      expect(binding?.group).toBe(1);
      expect(binding?.kind).toBe('uniform-buffer');

      const layout = result.artifact.bufferLayouts.find((l) => l.name === 'materialParams');
      expect(layout).toBeDefined();
      expect(layout?.fields.length).toBe(2);
    }
  });

  it('Fixture 6: Native compiler diagnostic is mapped accurately back to authoring leaf', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'error-provenance/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    const result = await cookLinkedSource(
      linked.standardWgsl,
      'asset://test/error-provenance.wgsl'
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.diagnostics.length).toBeGreaterThan(0);
      const diag = result.diagnostics[0]!;
      const mapped = remapLinkedDiagnostic(
        { line: diag.line ?? 1, column: diag.column, message: diag.message },
        linked
      );
      expect(mapped.moduleId).toBe(resolve(FIXTURES_ROOT, 'error-provenance/leaf_with_error.wgsl'));
      expect(mapped.span?.line).toBe(3);
    }
  });
});

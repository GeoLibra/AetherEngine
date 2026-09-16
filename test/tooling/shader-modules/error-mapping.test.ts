import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  resolveDependencyClosure,
  linkStrictWgsl,
  remapLinkedDiagnostic,
  type ModuleSourceLoader
} from '../../../tools/shader-cooker/modules';

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

describe('Shader Module Linking and Error Provenance', () => {
  it('links diamond closure into valid standard WGSL without duplicate declarations', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    expect(linked.standardWgsl).toContain('fn getBaseValue()');
    expect(linked.standardWgsl).toContain('fn getBValue()');
    expect(linked.standardWgsl).toContain('fn getCValue()');
    expect(linked.standardWgsl).toContain('fn fs_main()');

    // Make sure getBaseValue is defined exactly once
    const matches = linked.standardWgsl.match(/fn getBaseValue\(\)/g);
    expect(matches).toHaveLength(1);
  });

  it('remaps diagnostic line numbers back to original source file and line', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'error-provenance/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);
    const linked = linkStrictWgsl(closure);

    // Find the line where faultyFunction has `let badVal: vec3<f32> = 123.45;`
    const lines = linked.standardWgsl.split('\n');
    let errorLineInLinked = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.includes('let badVal: vec3<f32> = 123.45;')) {
        errorLineInLinked = i + 1;
        break;
      }
    }
    expect(errorLineInLinked).toBeGreaterThan(0);

    const remapped = remapLinkedDiagnostic(
      { line: errorLineInLinked, column: 7, message: 'type mismatch' },
      linked
    );

    expect(remapped.moduleId).toBe(resolve(FIXTURES_ROOT, 'error-provenance/leaf_with_error.wgsl'));
    // In leaf_with_error.wgsl, the statement is at line 3
    expect(remapped.span?.line).toBe(3);
    expect(remapped.span?.column).toBe(7);
  });
});

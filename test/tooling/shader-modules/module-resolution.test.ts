import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  createShaderModuleId,
  FileSystemShaderModuleLoader,
  normalizeShaderModuleId,
  resolveDependencyClosure,
  resolveShaderModuleSpecifier,
  ShaderModuleResolutionError,
  type ShaderModuleId,
  type ShaderModuleLoader,
  type ShaderModuleSource
} from '../../../tools/shader-cooker/modules';

const FIXTURES_ROOT = resolve(import.meta.dirname, 'fixtures');

describe('Shader Module Resolution and Identity Normalization', () => {
  it('normalizes canonical URIs and resolves path dots within authority', () => {
    // asset://engine/a/../b.wgsl -> asset://engine/b.wgsl
    expect(normalizeShaderModuleId('asset://engine/a/../b.wgsl')).toBe('asset://engine/b.wgsl');
    expect(normalizeShaderModuleId('package://shared/math/./vector.wgsl')).toBe(
      'package://shared/math/vector.wgsl'
    );
  });

  it('rejects escaping above authority root', () => {
    // asset://engine/../../b.wgsl -> reject
    expect(() => normalizeShaderModuleId('asset://engine/../../b.wgsl')).toThrow(
      /traverses above authority root/i
    );
    expect(() => normalizeShaderModuleId('package://core/../escape.wgsl')).toThrow(
      /traverses above authority root/i
    );
  });

  it('rejects forbidden characters (percent-encoding, backslashes, queries, fragments)', () => {
    // asset://engine/%2e%2e/b.wgsl -> reject
    expect(() => normalizeShaderModuleId('asset://engine/%2e%2e/b.wgsl')).toThrow(
      /forbidden characters/i
    );
    expect(() => normalizeShaderModuleId('asset://engine\\foo\\bar.wgsl')).toThrow(
      /forbidden characters/i
    );
    expect(() => normalizeShaderModuleId('asset://engine/file.wgsl?v=1')).toThrow(
      /forbidden characters/i
    );
    expect(() => normalizeShaderModuleId('asset://engine/file.wgsl#main')).toThrow(
      /forbidden characters/i
    );
  });

  it('correctly resolves relative specifiers against base module ID', () => {
    const baseId = createShaderModuleId('asset://test/materials/standard.wgsl');
    // ./common.wgsl -> relative resolve
    expect(resolveShaderModuleSpecifier('./common.wgsl', baseId)).toBe(
      'asset://test/materials/common.wgsl'
    );
    expect(resolveShaderModuleSpecifier('../shared/math.wgsl', baseId)).toBe(
      'asset://test/shared/math.wgsl'
    );
  });

  it('rejects bare specifiers without explicit scheme or relative prefix', () => {
    const baseId = createShaderModuleId('asset://test/materials/standard.wgsl');
    // bare/common.wgsl -> reject
    expect(() => resolveShaderModuleSpecifier('bare/common.wgsl', baseId)).toThrow(
      /Bare import specifier.*is not allowed/i
    );
    expect(() => resolveShaderModuleSpecifier('common.wgsl', baseId)).toThrow(
      /Bare import specifier.*is not allowed/i
    );
  });

  it('rejects import aliases under the current composition profile', async () => {
    const aliasedLoader: ShaderModuleLoader = {
      async loadModule(id: ShaderModuleId): Promise<ShaderModuleSource | undefined> {
        return {
          id,
          source: 'fn main() {}',
          imports: [{ path: './dep.wgsl', alias: 'aliased' }]
        };
      }
    };

    await expect(resolveDependencyClosure('asset://test/root.wgsl', aliasedLoader)).rejects.toThrow(
      'WGSL module import aliases are not supported by the current composition profile.'
    );
  });

  it('does NOT merge modules with identical content but distinct IDs', async () => {
    const identicalContent = 'fn compute() -> f32 { return 1.0; }';
    const store = new Map<string, ShaderModuleSource>([
      [
        'asset://test/root.wgsl',
        {
          id: createShaderModuleId('asset://test/root.wgsl'),
          source: 'fn main() {}',
          imports: [{ path: './modA.wgsl' }, { path: './modB.wgsl' }]
        }
      ],
      [
        'asset://test/modA.wgsl',
        {
          id: createShaderModuleId('asset://test/modA.wgsl'),
          source: identicalContent,
          imports: []
        }
      ],
      [
        'asset://test/modB.wgsl',
        {
          id: createShaderModuleId('asset://test/modB.wgsl'),
          source: identicalContent,
          imports: []
        }
      ]
    ]);

    const loader: ShaderModuleLoader = {
      async loadModule(id: ShaderModuleId): Promise<ShaderModuleSource | undefined> {
        return store.get(id as string);
      }
    };

    const closure = await resolveDependencyClosure('asset://test/root.wgsl', loader);
    expect(closure.modules).toHaveLength(3);
    const ids = closure.modules.map((m) => m.id as string);
    expect(ids).toContain('asset://test/modA.wgsl');
    expect(ids).toContain('asset://test/modB.wgsl');
  });

  it('resolves diamond dependency closure from filesystem with metadata imports', async () => {
    const loader = new FileSystemShaderModuleLoader({
      roots: { test: FIXTURES_ROOT }
    });

    const closure = await resolveDependencyClosure('asset://test/diamond/root.wgsl', loader);

    expect(closure.rootId).toBe('asset://test/diamond/root.wgsl');
    // Diamond closure: d, b, c, root (4 modules total, d only once)
    expect(closure.modules).toHaveLength(4);

    const moduleIds = closure.modules.map((m) => m.id as string);
    const dId = 'asset://test/diamond/d.wgsl';
    const bId = 'asset://test/diamond/b.wgsl';
    const cId = 'asset://test/diamond/c.wgsl';
    const rootId = 'asset://test/diamond/root.wgsl';

    const dIndex = moduleIds.indexOf(dId);
    const bIndex = moduleIds.indexOf(bId);
    const cIndex = moduleIds.indexOf(cId);
    const rootIndex = moduleIds.indexOf(rootId);

    expect(dIndex).toBeGreaterThanOrEqual(0);
    expect(dIndex).toBeLessThan(bIndex);
    expect(dIndex).toBeLessThan(cIndex);
    expect(rootIndex).toBe(closure.modules.length - 1);

    // Reverse dependencies check
    const rd = closure.reverseDependencies.get(createShaderModuleId(dId));
    expect(rd).toBeDefined();
    expect(rd).toContain(bId);
    expect(rd).toContain(cId);
  });

  it('detects cyclic dependencies and reports complete cycle path', async () => {
    const loader = new FileSystemShaderModuleLoader({
      roots: { test: FIXTURES_ROOT }
    });

    await expect(resolveDependencyClosure('asset://test/cycle/a.wgsl', loader)).rejects.toThrow(
      /Cyclic module dependency detected/
    );
  });

  it('fails fast on missing module with clear referrer diagnostic', async () => {
    const inMemoryLoader: ShaderModuleLoader = {
      async loadModule(id: ShaderModuleId) {
        if (id === 'asset://test/root.wgsl') {
          return {
            id,
            source: 'fn main() {}',
            imports: [{ path: './missing.wgsl' }]
          };
        }
        return undefined;
      }
    };

    await expect(
      resolveDependencyClosure('asset://test/root.wgsl', inMemoryLoader)
    ).rejects.toThrow(/Failed to resolve shader module.*missing\.wgsl.*imported by.*root\.wgsl/);
  });

  it('validates that filesystem loader rejects paths escaping allowed directory roots', async () => {
    const loader = new FileSystemShaderModuleLoader({
      roots: { test: FIXTURES_ROOT }
    });

    // In a crafted loader or URI that resolves outside
    await expect(
      loader.loadModule(createShaderModuleId('asset://test/../../outside.wgsl') as any)
    ).rejects.toThrow();
  });

  it('produces different composite hashes for graphs with identical modules and order but different dependency edges', async () => {
    // Both graphs have modules [leaf, mid, root] in the exact same order and identical source text.
    // Graph 1: root -> mid -> leaf (root does not directly import leaf)
    // Graph 2: root -> mid, root -> leaf, mid -> leaf (root directly imports both mid and leaf)
    const leafSource = 'fn leaf() -> f32 { return 1.0; }';
    const midSource = 'fn mid() -> f32 { return 2.0; }';
    const rootSource = 'fn root() -> f32 { return 3.0; }';

    const graph1Loader: ShaderModuleLoader = {
      async loadModule(id: ShaderModuleId) {
        if (id === 'asset://test/root.wgsl') {
          return { id, source: rootSource, imports: [{ path: './mid.wgsl' }] };
        }
        if (id === 'asset://test/mid.wgsl') {
          return { id, source: midSource, imports: [{ path: './leaf.wgsl' }] };
        }
        if (id === 'asset://test/leaf.wgsl') {
          return { id, source: leafSource, imports: [] };
        }
        return undefined;
      }
    };

    const graph2Loader: ShaderModuleLoader = {
      async loadModule(id: ShaderModuleId) {
        if (id === 'asset://test/root.wgsl') {
          return {
            id,
            source: rootSource,
            imports: [{ path: './mid.wgsl' }, { path: './leaf.wgsl' }]
          };
        }
        if (id === 'asset://test/mid.wgsl') {
          return { id, source: midSource, imports: [{ path: './leaf.wgsl' }] };
        }
        if (id === 'asset://test/leaf.wgsl') {
          return { id, source: leafSource, imports: [] };
        }
        return undefined;
      }
    };

    const closure1 = await resolveDependencyClosure('asset://test/root.wgsl', graph1Loader);
    const closure2 = await resolveDependencyClosure('asset://test/root.wgsl', graph2Loader);

    // Verify both closures have identical module sets and topological order
    expect(closure1.modules.map((m) => m.id)).toEqual(closure2.modules.map((m) => m.id));
    expect(closure1.modules.map((m) => m.contentHash)).toEqual(
      closure2.modules.map((m) => m.contentHash)
    );

    // But composite hashes must differ because dependency edges differ
    expect(closure1.compositeHash).not.toBe(closure2.compositeHash);
  });

  it('FileSystemShaderModuleLoader prioritizes moduleOverrides over convention-based disk files', async () => {
    const overriddenSource: ShaderModuleSource = {
      id: createShaderModuleId('asset://test/root.wgsl'),
      source: 'fn overridden() {}',
      imports: [{ path: 'asset://test/other.wgsl' }]
    };

    const loader = new FileSystemShaderModuleLoader({
      roots: { test: FIXTURES_ROOT },
      moduleOverrides: {
        'asset://test/root.wgsl': overriddenSource
      }
    });

    const loaded = await loader.loadModule(createShaderModuleId('asset://test/root.wgsl'));
    expect(loaded).toBe(overriddenSource);
    expect(loaded?.source).toBe('fn overridden() {}');
    expect(loaded?.imports).toEqual([{ path: 'asset://test/other.wgsl' }]);
  });
});

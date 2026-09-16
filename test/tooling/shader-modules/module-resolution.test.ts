import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  resolveDependencyClosure,
  resolveModuleSpecifier,
  type ModuleSourceLoader,
  createShaderModuleId
} from '../../../tools/shader-cooker/modules';

const FIXTURES_ROOT = resolve(import.meta.dirname, 'fixtures');

const fileSystemLoader: ModuleSourceLoader = {
  async loadSource(uri: string): Promise<string | undefined> {
    const filePath = uri.startsWith('asset://test/')
      ? resolve(FIXTURES_ROOT, uri.slice('asset://test/'.length))
      : uri;
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }
};

describe('Shader Module Resolution and Dependency Traversal', () => {
  it('correctly resolves relative specifiers and asset URIs', () => {
    const baseId = createShaderModuleId('asset://test/materials/standard.wgsl');
    expect(resolveModuleSpecifier('./common/uv.wgsl', baseId)).toBe(
      'asset://test/materials/common/uv.wgsl'
    );
    expect(resolveModuleSpecifier('../shared/math.wgsl', baseId)).toBe(
      'asset://test/shared/math.wgsl'
    );
    expect(resolveModuleSpecifier('asset://engine/brdf.wgsl', baseId)).toBe(
      'asset://engine/brdf.wgsl'
    );
  });

  it('resolves diamond dependency closure without duplicate modules', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl');
    const closure = await resolveDependencyClosure(rootPath, fileSystemLoader);

    expect(closure.rootId).toBe(rootPath);
    // Closure should have d, b, c, root (4 modules total, d only once)
    expect(closure.modules).toHaveLength(4);

    const moduleIds = closure.modules.map((m) => m.id);
    const dPath = resolve(FIXTURES_ROOT, 'diamond/d.wgsl');
    const bPath = resolve(FIXTURES_ROOT, 'diamond/b.wgsl');
    const cPath = resolve(FIXTURES_ROOT, 'diamond/c.wgsl');

    // d must be visited and placed before b and c
    const dIndex = moduleIds.indexOf(dPath as any);
    const bIndex = moduleIds.indexOf(bPath as any);
    const cIndex = moduleIds.indexOf(cPath as any);
    const rootIndex = moduleIds.indexOf(rootPath as any);

    expect(dIndex).toBeGreaterThanOrEqual(0);
    expect(dIndex).toBeLessThan(bIndex);
    expect(dIndex).toBeLessThan(cIndex);
    expect(rootIndex).toBe(closure.modules.length - 1);

    // Reverse dependencies check
    const rd = closure.reverseDependencies.get(dPath as any);
    expect(rd).toBeDefined();
    expect(rd).toContain(bPath);
    expect(rd).toContain(cPath);
  });

  it('detects cyclic dependencies and reports complete cycle path', async () => {
    const rootPath = resolve(FIXTURES_ROOT, 'cycle/a.wgsl');
    await expect(resolveDependencyClosure(rootPath, fileSystemLoader)).rejects.toThrow(
      /Cyclic module dependency detected/
    );
  });

  it('fails fast on missing module with clear referrer diagnostic', async () => {
    const inMemoryLoader: ModuleSourceLoader = {
      loadSource(uri: string) {
        if (uri === 'asset://test/root.wgsl') {
          return '#import "./missing.wgsl"\nfn main() {}';
        }
        return undefined;
      }
    };

    await expect(
      resolveDependencyClosure('asset://test/root.wgsl', inMemoryLoader)
    ).rejects.toThrow(/Failed to resolve shader module.*missing\.wgsl/);
  });
});

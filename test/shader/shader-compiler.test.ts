import { describe, expect, test } from 'vitest';
import {
  InMemoryShaderSourceResolver,
  ShaderCompiler,
  type ShaderCompileRequest
} from '../../src/shader';

describe('Shader compiler binding requirements', () => {
  test('carries typed requirements through cache identity and compiled reflection', async () => {
    const uri = 'asset://shader/non-filtering.flux';
    const compiler = new ShaderCompiler({
      resolver: new InMemoryShaderSourceResolver({
        [uri]: [
          '@group(0) @binding(0) var surfaceSampler: sampler;',
          '@fragment fn main() {}'
        ].join('\n')
      }),
      validators: { wgsl: { validate: async () => [] } },
      versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
    });
    const base: ShaderCompileRequest = {
      revision: 1,
      source: { uri, languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: {},
      capabilities: []
    };
    const filtering = await compiler.compile(base);
    const nonFiltering = await compiler.compile({
      ...base,
      revision: 2,
      bindingRequirements: [{ kind: 'sampler', group: 0, binding: 0, samplerType: 'non-filtering' }]
    });

    expect(filtering.status).toBe('compiled');
    expect(nonFiltering.status).toBe('compiled');
    expect(nonFiltering.key).not.toBe(filtering.key);
    expect(
      filtering.status === 'compiled' && filtering.artifact.manifest.groups[0]?.entries[0]
    ).toMatchObject({ kind: 'sampler', samplerType: 'filtering' });
    expect(
      nonFiltering.status === 'compiled' && nonFiltering.artifact.manifest.groups[0]?.entries[0]
    ).toMatchObject({ kind: 'sampler', samplerType: 'non-filtering' });
  });

  test('publishes a resolvable nested layout for a bound storage array root', async () => {
    const uri = 'asset://shader/storage-array-root.flux';
    const compiler = new ShaderCompiler({
      resolver: new InMemoryShaderSourceResolver({
        [uri]: [
          '@group(2) @binding(3) var<storage, read_write> transforms: array<mat2x2<f32>, 2>;',
          '@fragment fn main() {}'
        ].join('\n')
      }),
      validators: { wgsl: { validate: async () => [] } },
      versions: { compiler: 1, ir: 1, abi: 7, backend: 1 }
    });

    const result = await compiler.compile({
      revision: 1,
      source: { uri, languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: {},
      capabilities: []
    });

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') throw new Error('Expected a compiled shader artifact.');
    const bufferEntry = result.artifact.manifest.groups[0]?.entries[0];
    expect(bufferEntry).toMatchObject({
      kind: 'storage-buffer',
      group: 2,
      binding: 3,
      bufferLayoutName: 'transforms'
    });
    if (bufferEntry?.kind !== 'storage-buffer') throw new Error('Expected a storage buffer entry.');
    const layouts = result.artifact.manifest.buffers.filter(
      (buffer) => buffer.name === bufferEntry.bufferLayoutName
    );
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({
      name: 'transforms',
      shaderAbiVersion: 7,
      addressSpace: 'storage',
      access: 'read_write',
      policy: 'wgsl-storage',
      byteSize: 32,
      fields: [
        {
          path: '$root',
          stride: 16,
          shape: {
            kind: 'array',
            length: 2,
            stride: 16,
            element: { kind: 'matrix', columns: 2, rows: 2, columnStride: 8 }
          }
        }
      ]
    });
    expect(layouts[0]?.layoutHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

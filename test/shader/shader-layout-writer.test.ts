import { describe, expect, test } from 'vitest';
import {
  ShaderParameterWriter,
  createBufferLayoutManifest,
  createShaderBindingManifest,
  type ShaderStructTypeIR
} from '../../src/shader';

const Light: ShaderStructTypeIR = {
  kind: 'struct',
  name: 'Light',
  fields: [
    { name: 'direction', type: 'vec3<f32>' },
    { name: 'enabled', type: 'bool' },
    { name: 'indices', type: 'array<u32, 2>' },
    { name: 'transform', type: 'mat3x3<f32>' }
  ]
};
const Scene: ShaderStructTypeIR = {
  kind: 'struct',
  name: 'Scene',
  fields: [
    { name: 'light', type: 'Light' },
    { name: 'weights', type: 'array<f32, 3>' }
  ]
};

describe('shader ABI reflection and writer', () => {
  test('lays out vec3, matrices, arrays and nested structs deterministically', () => {
    const manifest = createBufferLayoutManifest('SceneBuffer', Scene, [Light, Scene], 1);
    expect(manifest.fields.find((field) => field.path === 'light.direction')).toMatchObject({
      offset: 0,
      size: 12,
      alignment: 16,
      scalarKind: 'f32'
    });
    expect(manifest.fields.find((field) => field.path === 'light.enabled')?.offset).toBe(12);
    expect(manifest.fields.find((field) => field.path === 'light.indices')).toMatchObject({
      offset: 16,
      stride: 16,
      scalarKind: 'u32'
    });
    expect(manifest.fields.find((field) => field.path === 'light.transform')).toMatchObject({
      offset: 48,
      stride: 16
    });
    expect(manifest.byteSize % 16).toBe(0);
  });

  test('uses the largest member alignment for scalar-only structs', () => {
    const ScalarOnly: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'ScalarOnly',
      fields: [{ name: 'value', type: 'f32' }]
    };

    const manifest = createBufferLayoutManifest('ScalarOnly', ScalarOnly, [ScalarOnly], 1, {
      target: 'wgsl',
      addressSpace: 'storage'
    });

    expect(manifest.alignment).toBe(4);
    expect(manifest.byteSize).toBe(4);
  });

  test('selects explicit uniform, storage and std140 policies', () => {
    const Scalars: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'Scalars',
      fields: [
        { name: 'enabled', type: 'bool' },
        { name: 'indices', type: 'array<u32, 2>' },
        { name: 'basis', type: 'mat2x2<f32>' }
      ]
    };

    const uniform = createBufferLayoutManifest('Uniform', Scalars, [Scalars], 1, {
      target: 'wgsl',
      addressSpace: 'uniform'
    });
    const storage = createBufferLayoutManifest('Storage', Scalars, [Scalars], 1, {
      target: 'wgsl',
      addressSpace: 'storage',
      access: 'read_write'
    });
    const std140 = createBufferLayoutManifest('Std140', Scalars, [Scalars], 1, {
      target: 'glsl300es',
      addressSpace: 'uniform'
    });

    expect(uniform).toMatchObject({ policy: 'wgsl-uniform', alignment: 16 });
    expect(storage).toMatchObject({ policy: 'wgsl-storage', alignment: 8 });
    expect(std140).toMatchObject({ policy: 'glsl-std140', alignment: 16 });
    expect(uniform.fields.find((field) => field.path === 'indices')?.stride).toBe(16);
    expect(storage.fields.find((field) => field.path === 'indices')?.stride).toBe(4);
    expect(storage.fields.find((field) => field.path === 'basis')?.stride).toBe(8);
    expect(std140.fields.find((field) => field.path === 'basis')?.stride).toBe(16);
  });

  test('rejects recursive structs and WebGL2 storage layouts structurally', () => {
    const Recursive: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'Recursive',
      fields: [{ name: 'next', type: 'Recursive' }]
    };
    expect(() => createBufferLayoutManifest('Recursive', Recursive, [Recursive], 1)).toThrow(
      'Recursive shader ABI struct cycle'
    );

    expect(() =>
      createShaderBindingManifest(
        {
          version: 1,
          types: [Recursive],
          globals: [
            {
              name: 'data',
              type: 'Recursive',
              addressSpace: 'storage',
              access: 'read_write',
              group: 0,
              binding: 0,
              span: { uri: 'asset://layout', line: 1, column: 1, length: 1 }
            }
          ],
          functions: [],
          entryPoints: [],
          variants: [],
          sourceMap: { spans: [] },
          sourceClosureHash: 'recursive'
        },
        1,
        'glsl300es'
      )
    ).toThrow('does not support storage-buffer');
  });

  test('lays out arrays of custom structs without losing element paths', () => {
    const Sample: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'Sample',
      fields: [{ name: 'value', type: 'f32' }]
    };
    const Samples: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'Samples',
      fields: [{ name: 'items', type: 'array<Sample, 2>' }]
    };

    const manifest = createBufferLayoutManifest('Samples', Samples, [Sample, Samples], 1);

    expect(manifest.fields).toEqual([
      expect.objectContaining({ path: 'items[0].value', offset: 0 }),
      expect.objectContaining({ path: 'items[1].value', offset: 16 })
    ]);
    expect(manifest.byteSize).toBe(32);
  });

  test('writes real scalar bit representations through the manifest', () => {
    const manifest = createBufferLayoutManifest('SceneBuffer', Scene, [Light, Scene], 1);
    const bytes = new ArrayBuffer(manifest.byteSize);
    const writer = new ShaderParameterWriter(manifest, bytes);
    writer.write('light.direction', [1.5, -2, 3]);
    writer.write('light.enabled', true);
    writer.write('light.indices', [0xffff_ffff, 7]);

    const direction = manifest.fields.find((field) => field.path === 'light.direction')!;
    const enabled = manifest.fields.find((field) => field.path === 'light.enabled')!;
    const indices = manifest.fields.find((field) => field.path === 'light.indices')!;
    expect(new Float32Array(bytes, direction.offset, 3)[0]).toBe(1.5);
    expect(new Uint32Array(bytes, enabled.offset, 1)[0]).toBe(1);
    expect(new Uint32Array(bytes, indices.offset, 1)[0]).toBe(0xffff_ffff);
    expect(new Uint32Array(bytes, indices.offset + indices.stride!, 1)[0]).toBe(7);
    expect(() => writer.write('missing', 1)).toThrow('Unknown shader field');
  });

  test('reflects binding groups, uniform buffers and entry IO into one layout hash', () => {
    const manifest = createShaderBindingManifest(
      {
        version: 1,
        types: [Light, Scene],
        globals: [
          {
            name: 'scene',
            type: 'Scene',
            addressSpace: 'uniform',
            access: 'read',
            group: 0,
            binding: 0,
            span: { uri: 'asset://s', line: 1, column: 1, length: 1 }
          },
          {
            name: 'position',
            type: 'vec3<f32>',
            addressSpace: 'in',
            access: 'read',
            location: 0,
            span: { uri: 'asset://s', line: 2, column: 1, length: 1 }
          },
          {
            name: 'color',
            type: 'vec4<f32>',
            addressSpace: 'out',
            access: 'read',
            location: 0,
            span: { uri: 'asset://s', line: 3, column: 1, length: 1 }
          }
        ],
        functions: [],
        entryPoints: [],
        variants: [],
        sourceMap: { spans: [] },
        sourceClosureHash: 'x'
      },
      1
    );
    expect(manifest.groups[0]?.entries[0]).toMatchObject({
      binding: 0,
      name: 'scene',
      kind: 'uniform-buffer'
    });
    expect(manifest.buffers[0]?.name).toBe('scene');
    expect(manifest.buffers[0]).toMatchObject({
      target: 'wgsl',
      addressSpace: 'uniform',
      access: 'read',
      policy: 'wgsl-uniform'
    });
    expect(manifest.vertexInputs[0]).toMatchObject({ location: 0, name: 'position' });
    expect(manifest.fragmentOutputs[0]).toMatchObject({ location: 0, name: 'color' });
    expect(manifest.layoutHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

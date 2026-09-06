import { describe, expect, test } from 'vitest';
import {
  ShaderBindingReflectionError,
  ShaderParameterWriter,
  createBufferLayoutManifest,
  createShaderBindingManifest,
  type ShaderModuleIR
} from '../../src/shader';
import {
  InMemoryShaderSourceResolver,
  parseFluxShader,
  resolveShaderSource
} from '../../src/shader/experimental/flux/frontend';

const SOURCE_URI = 'asset://shader/material-bindings.flux';

describe('Shader binding manifest', () => {
  test('publishes shader ABI and conservative canonical visibility for bootstrap modules', async () => {
    const ir = await parseBindings(['@group(0) @binding(0) var albedo: texture_2d<f32>;']);

    const manifest = createShaderBindingManifest(ir, 7);

    expect(manifest.shaderAbiVersion).toBe(7);
    expect(manifest.groups[0]?.visibility).toEqual(['vertex', 'fragment']);
    expect(Object.isFrozen(manifest.groups[0]?.visibility)).toBe(true);
  });

  test('deduplicates entry-point stages in canonical order and hashes ABI identity', async () => {
    const ir = await parseBindings([
      '@group(0) @binding(0) var albedo: texture_2d<f32>;',
      '@compute fn computeMain() {}',
      '@vertex fn vertexMain() {}',
      '@fragment fn fragmentMain() {}',
      '@vertex fn shadowMain() {}'
    ]);

    const abiOne = createShaderBindingManifest(ir, 1);
    const abiTwo = createShaderBindingManifest(ir, 2);

    expect(abiOne.groups[0]?.visibility).toEqual(['vertex', 'fragment', 'compute']);
    expect(abiOne.layoutHash).not.toBe(abiTwo.layoutHash);
  });

  test('reflects buffers, typed textures and typed samplers through one manifest', async () => {
    const ir = await parseBindings([
      'struct MaterialData { roughness: f32 };',
      '@group(0) @binding(0) var<uniform> material: MaterialData;',
      '@group(0) @binding(1) var albedo: texture_2d<f32>;',
      '@group(0) @binding(2) var environment: texture_cube<f32>;',
      '@group(0) @binding(3) var resolvedColor: texture_multisampled_2d<f32>;',
      '@group(0) @binding(4) var shadowMap: texture_depth_2d;',
      '@group(0) @binding(5) var linearSampler: sampler;',
      '@group(0) @binding(6) var shadowSampler: sampler_comparison;',
      '@group(0) @binding(7) var lightIndices: texture_2d<u32>;'
    ]);

    const manifest = createShaderBindingManifest(ir, 1);

    expect(manifest.groups[0]?.entries).toEqual([
      {
        kind: 'uniform-buffer',
        group: 0,
        binding: 0,
        name: 'material',
        bufferLayoutName: 'material'
      },
      {
        kind: 'texture',
        group: 0,
        binding: 1,
        name: 'albedo',
        viewDimension: '2d',
        sampleType: 'float',
        multisampled: false
      },
      {
        kind: 'texture',
        group: 0,
        binding: 2,
        name: 'environment',
        viewDimension: 'cube',
        sampleType: 'float',
        multisampled: false
      },
      {
        kind: 'texture',
        group: 0,
        binding: 3,
        name: 'resolvedColor',
        viewDimension: '2d',
        sampleType: 'float',
        multisampled: true
      },
      {
        kind: 'texture',
        group: 0,
        binding: 4,
        name: 'shadowMap',
        viewDimension: '2d',
        sampleType: 'depth',
        multisampled: false
      },
      {
        kind: 'sampler',
        group: 0,
        binding: 5,
        name: 'linearSampler',
        samplerType: 'filtering'
      },
      {
        kind: 'sampler',
        group: 0,
        binding: 6,
        name: 'shadowSampler',
        samplerType: 'comparison'
      },
      {
        kind: 'texture',
        group: 0,
        binding: 7,
        name: 'lightIndices',
        viewDimension: '2d',
        sampleType: 'uint',
        multisampled: false
      }
    ]);
    expect(manifest.buffers).toHaveLength(1);
    expect(manifest.buffers[0]?.name).toBe('material');
  });

  test('requires an explicit typed requirement for a non-filtering sampler', async () => {
    const ir = await parseBindings(['@group(2) @binding(7) var nearestSampler: sampler;']);

    const manifest = createShaderBindingManifest(ir, 1, 'wgsl', {
      bindingRequirements: [{ kind: 'sampler', group: 2, binding: 7, samplerType: 'non-filtering' }]
    });

    expect(manifest.groups[0]?.entries).toEqual([
      {
        kind: 'sampler',
        group: 2,
        binding: 7,
        name: 'nearestSampler',
        samplerType: 'non-filtering'
      }
    ]);
  });

  test('rejects unsupported handle types with a structured reflection error', async () => {
    const ir = await parseBindings(['@group(0) @binding(3) var volume: texture_3d<f32>;']);

    expectBindingError(() => createShaderBindingManifest(ir, 1), 'unsupported-binding-type', 0, 3);
  });

  test('rejects duplicate, missing, non-sampler and source-conflicting requirements', async () => {
    const ir = await parseBindings([
      'struct Data { value: f32 };',
      '@group(0) @binding(0) var<uniform> data: Data;',
      '@group(0) @binding(1) var linearSampler: sampler;',
      '@group(0) @binding(2) var shadowSampler: sampler_comparison;'
    ]);

    expectBindingError(
      () =>
        createShaderBindingManifest(ir, 1, 'wgsl', {
          bindingRequirements: [
            { kind: 'sampler', group: 0, binding: 1, samplerType: 'filtering' },
            { kind: 'sampler', group: 0, binding: 1, samplerType: 'non-filtering' }
          ]
        }),
      'duplicate-binding-requirement',
      0,
      1
    );
    expectBindingError(
      () =>
        createShaderBindingManifest(ir, 1, 'wgsl', {
          bindingRequirements: [{ kind: 'sampler', group: 9, binding: 9, samplerType: 'filtering' }]
        }),
      'missing-binding-requirement-target',
      9,
      9
    );
    expectBindingError(
      () =>
        createShaderBindingManifest(ir, 1, 'wgsl', {
          bindingRequirements: [{ kind: 'sampler', group: 0, binding: 0, samplerType: 'filtering' }]
        }),
      'binding-requirement-kind-mismatch',
      0,
      0
    );
    expectBindingError(
      () =>
        createShaderBindingManifest(ir, 1, 'wgsl', {
          bindingRequirements: [
            { kind: 'sampler', group: 0, binding: 2, samplerType: 'non-filtering' }
          ]
        }),
      'binding-requirement-conflict',
      0,
      2
    );
  });

  test('preserves nested ABI shape and writes arrays of matrices with both strides', () => {
    const Nested: ShaderModuleIR['types'][number] = {
      kind: 'struct',
      name: 'Nested',
      fields: [{ name: 'transforms', type: 'array<mat2x2<f32>, 2>' }]
    };
    const manifest = createBufferLayoutManifest('Nested', Nested, [Nested], 1, {
      target: 'glsl300es',
      addressSpace: 'uniform'
    });

    expect(manifest.fields[0]).toMatchObject({
      path: 'transforms',
      offset: 0,
      size: 64,
      scalarKind: 'f32',
      elementCount: 8,
      shape: {
        kind: 'array',
        length: 2,
        stride: 32,
        element: { kind: 'matrix', columns: 2, rows: 2, columnStride: 16 }
      }
    });
    const buffer = new ArrayBuffer(manifest.byteSize);
    new ShaderParameterWriter(manifest, buffer).write('transforms', [1, 2, 3, 4, 5, 6, 7, 8]);
    const view = new DataView(buffer);
    expect([0, 4, 16, 20, 32, 36, 48, 52].map((offset) => view.getFloat32(offset, true))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8
    ]);
    expect([8, 12, 24, 28, 40, 44, 56, 60].map((offset) => view.getUint32(offset, true))).toEqual(
      new Array(8).fill(0)
    );
  });

  test('canonicalizes semantically unordered buffers and stage IO in the layout hash', async () => {
    const declarations = [
      'struct First { value: f32 };',
      'struct Second { value: vec4<f32> };',
      '@group(1) @binding(0) var<uniform> second: Second;',
      '@group(0) @binding(0) var<uniform> first: First;',
      '@location(1) var<in> normal: vec3<f32>;',
      '@location(0) var<in> position: vec3<f32>;',
      '@location(1) var<out> emissive: vec4<f32>;',
      '@location(0) var<out> color: vec4<f32>;'
    ];
    const reordered = [
      declarations[0]!,
      declarations[1]!,
      declarations[7]!,
      declarations[5]!,
      declarations[3]!,
      declarations[6]!,
      declarations[4]!,
      declarations[2]!
    ];

    const first = createShaderBindingManifest(await parseBindings(declarations), 1);
    const second = createShaderBindingManifest(await parseBindings(reordered), 1);

    expect(second.layoutHash).toBe(first.layoutHash);
    expect(second.buffers).toEqual(first.buffers);
    expect(second.vertexInputs).toEqual(first.vertexInputs);
    expect(second.fragmentOutputs).toEqual(first.fragmentOutputs);
  });

  test('creates exactly one canonical layout for every accepted non-struct buffer root', async () => {
    const ir = await parseBindings([
      '@group(0) @binding(0) var<uniform> scalarRoot: f32;',
      '@group(0) @binding(1) var<uniform> vectorRoot: vec3<u32>;',
      '@group(0) @binding(2) var<uniform> matrixRoot: mat2x3<f32>;',
      '@group(0) @binding(3) var<storage, read_write> arrayRoot: array<mat2x2<f32>, 2>;'
    ]);

    const manifest = createShaderBindingManifest(ir, 1);
    expectEveryBufferBindingToResolveOnce(manifest);
    expect.soft(manifest.buffers.find((buffer) => buffer.name === 'scalarRoot')).toMatchObject({
      byteSize: 4,
      alignment: 4,
      fields: [
        {
          path: '$root',
          offset: 0,
          size: 4,
          alignment: 4,
          scalarKind: 'f32',
          elementCount: 1,
          shape: { kind: 'scalar' }
        }
      ]
    });
    expect.soft(manifest.buffers.find((buffer) => buffer.name === 'vectorRoot')).toMatchObject({
      byteSize: 12,
      alignment: 16,
      fields: [
        {
          path: '$root',
          offset: 0,
          size: 12,
          alignment: 16,
          scalarKind: 'u32',
          elementCount: 3,
          shape: { kind: 'vector', length: 3 }
        }
      ]
    });
    expect(manifest.buffers.find((buffer) => buffer.name === 'matrixRoot')?.fields).toEqual([
      expect.objectContaining({
        path: '$root',
        offset: 0,
        stride: 16,
        shape: { kind: 'matrix', columns: 2, rows: 3, columnStride: 16 }
      })
    ]);
    expect(manifest.buffers.find((buffer) => buffer.name === 'arrayRoot')).toMatchObject({
      addressSpace: 'storage',
      access: 'read_write',
      policy: 'wgsl-storage',
      byteSize: 32,
      fields: [
        {
          path: '$root',
          offset: 0,
          size: 32,
          alignment: 8,
          stride: 16,
          scalarKind: 'f32',
          elementCount: 8,
          shape: {
            kind: 'array',
            length: 2,
            stride: 16,
            element: { kind: 'matrix', columns: 2, rows: 2, columnStride: 8 }
          }
        }
      ]
    });

    const reordered = createShaderBindingManifest(
      { ...ir, globals: Object.freeze([...ir.globals].reverse()) },
      1
    );
    expect(reordered.buffers).toEqual(manifest.buffers);
    expect(reordered.layoutHash).toBe(manifest.layoutHash);
    expect(manifest.layoutHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('rejects duplicate group and binding coordinates in direct IR', async () => {
    const ir = await parseBindings(['@group(0) @binding(0) var first: texture_2d<f32>;']);
    const duplicate: ShaderModuleIR = {
      ...ir,
      globals: [
        ...ir.globals,
        {
          ...ir.globals[0]!,
          name: 'second'
        }
      ]
    };

    expectBindingError(
      () => createShaderBindingManifest(duplicate, 1),
      'duplicate-reflected-binding',
      0,
      0
    );
  });
});

async function parseBindings(lines: readonly string[]): Promise<ShaderModuleIR> {
  const resolver = new InMemoryShaderSourceResolver({ [SOURCE_URI]: lines.join('\n') });
  const closure = await resolveShaderSource({ uri: SOURCE_URI, languageVersion: 1 }, resolver);
  const result = parseFluxShader(closure);
  expect(result.diagnostics).toEqual([]);
  if (result.ir === undefined) throw new Error('Expected parsed ShaderModuleIR.');
  return result.ir;
}

function expectBindingError(
  operation: () => unknown,
  code: string,
  group: number,
  binding: number
): void {
  try {
    operation();
    throw new Error('Expected ShaderBindingReflectionError.');
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderBindingReflectionError);
    expect((error as ShaderBindingReflectionError).diagnostic).toMatchObject({
      code,
      group,
      binding
    });
  }
}

function expectEveryBufferBindingToResolveOnce(
  manifest: ReturnType<typeof createShaderBindingManifest>
): void {
  const bufferEntries = manifest.groups.flatMap((group) =>
    group.entries.filter(
      (entry) => entry.kind === 'uniform-buffer' || entry.kind === 'storage-buffer'
    )
  );
  expect(bufferEntries).not.toHaveLength(0);
  for (const entry of bufferEntries) {
    if (entry.kind !== 'uniform-buffer' && entry.kind !== 'storage-buffer') continue;
    expect(
      manifest.buffers.filter((buffer) => buffer.name === entry.bufferLayoutName)
    ).toHaveLength(1);
  }
}

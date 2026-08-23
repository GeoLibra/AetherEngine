import { describe, expect, test } from 'vitest';
import type { BindingLayoutPlan } from '../../src/rendering';
import { lowerBindingLayoutPlan } from '../../src/rendering';

describe('Binding layout lowering', () => {
  test('preserves resource coordinates across WebGPU and WebGL2 plans', () => {
    const plan = fixture();
    const webgpu = lowerBindingLayoutPlan(plan, 'webgpu');
    const webgl2 = lowerBindingLayoutPlan(plan, 'webgl2', { allowWebGl2StorageBuffers: true });

    expect(webgpu.kind).toBe('webgpu');
    expect(webgl2.kind).toBe('webgl2');
    if (webgpu.kind !== 'webgpu' || webgl2.kind !== 'webgl2') return;
    expect(webgpu.groups.map((group) => group.group)).toEqual([0, 2]);
    expect(webgpu.groups[1]?.descriptor.entries[0]).toMatchObject({
      binding: 3,
      visibility: 4,
      buffer: { type: 'read-only-storage', hasDynamicOffset: true, minBindingSize: 128 }
    });
    expect(webgl2.uniformBlocks[0]).toMatchObject({ group: 0, binding: 1, byteSize: 64 });
    expect(webgl2.textures[0]).toMatchObject({ group: 0, binding: 4, textureUnit: 0 });
    expect(webgl2.samplers[0]).toMatchObject({ group: 0, binding: 5, textureUnit: 0 });
  });

  test('returns typed unsupported for unapproved storage semantics and target limits', () => {
    expect(lowerBindingLayoutPlan(fixture(), 'webgl2')).toMatchObject({
      kind: 'unsupported',
      diagnostic: { code: 'storage-buffer-unsupported', group: 2, binding: 3 }
    });
    expect(lowerBindingLayoutPlan(fixture(), 'webgpu', { maxBindGroups: 1 })).toMatchObject({
      kind: 'unsupported',
      diagnostic: { code: 'bind-group-limit-exceeded' }
    });
  });
});

function fixture(): BindingLayoutPlan {
  return Object.freeze({
    id: 'fixture' as BindingLayoutPlan['id'],
    sourceLayoutHash: 'shader-layout:fixture',
    shaderAbiVersion: 1,
    groups: Object.freeze([
      Object.freeze({
        group: 0,
        visibility: Object.freeze(['vertex', 'fragment'] as const),
        bindings: Object.freeze([
          Object.freeze({
            kind: 'uniform-buffer' as const,
            group: 0,
            binding: 1,
            access: 'read' as const,
            minimumByteSize: 64,
            bufferLayoutHash: 'uniform',
            dynamicOffset: false
          }),
          Object.freeze({
            kind: 'texture' as const,
            group: 0,
            binding: 4,
            viewDimension: '2d' as const,
            sampleType: 'float' as const,
            multisampled: false
          }),
          Object.freeze({
            kind: 'sampler' as const,
            group: 0,
            binding: 5,
            samplerType: 'filtering' as const
          })
        ])
      }),
      Object.freeze({
        group: 2,
        visibility: Object.freeze(['compute'] as const),
        bindings: Object.freeze([
          Object.freeze({
            kind: 'storage-buffer' as const,
            group: 2,
            binding: 3,
            access: 'read' as const,
            minimumByteSize: 128,
            bufferLayoutHash: 'storage',
            dynamicOffset: true
          })
        ])
      })
    ]),
    dynamicOffsetOrder: Object.freeze([{ group: 2, binding: 3 }]),
    backendRequirements: Object.freeze([]),
    hash: 'fixture-hash'
  });
}

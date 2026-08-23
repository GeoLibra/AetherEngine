import { describe, expect, test } from 'vitest';
import type { ShaderBindingManifest } from '../../src/shader';
import { compileBindingLayoutPlan } from '../../src/rendering';

describe('Binding layout compiler', () => {
  test('canonicalizes groups, bindings, visibility and dynamic offsets', () => {
    const result = compileBindingLayoutPlan(manifest(), {
      dynamicOffsetLocations: [
        { group: 2, binding: 3 },
        { group: 0, binding: 1 }
      ]
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.plan.groups.map((group) => group.group)).toEqual([0, 2]);
    expect(result.plan.groups[0]?.bindings.map((binding) => binding.binding)).toEqual([1, 4]);
    expect(result.plan.groups[0]?.visibility).toEqual(['vertex', 'fragment']);
    expect(result.plan.groups[0]?.bindings).toMatchObject([
      {
        kind: 'uniform-buffer',
        access: 'read',
        minimumByteSize: 64,
        bufferLayoutHash: 'buffer-layout',
        dynamicOffset: true
      },
      {
        kind: 'texture',
        viewDimension: '2d',
        sampleType: 'float',
        multisampled: false
      }
    ]);
    expect(result.plan.dynamicOffsetOrder).toEqual([
      { group: 0, binding: 1 },
      { group: 2, binding: 3 }
    ]);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.groups[0]?.bindings)).toBe(true);
  });

  test('is stable across manifest insertion order and guards ABI collisions', () => {
    const forward = manifest();
    const reordered = { ...forward, groups: [...forward.groups].reverse() };
    const first = compileBindingLayoutPlan(forward);
    const second = compileBindingLayoutPlan(reordered);
    const nextAbi = compileBindingLayoutPlan({ ...forward, shaderAbiVersion: 2 });

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    expect(nextAbi.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success' || nextAbi.kind !== 'success') return;
    expect(first.plan.id).toBe(second.plan.id);
    expect(first.plan.hash).toBe(second.plan.hash);
    expect(first.plan.id).not.toBe(nextAbi.plan.id);
  });

  test('returns typed diagnostics for duplicate locations and invalid dynamic offsets', () => {
    const source = manifest();
    const duplicate = compileBindingLayoutPlan({
      ...source,
      groups: [...source.groups, source.groups[0]!]
    });
    const nonBufferDynamic = compileBindingLayoutPlan(source, {
      dynamicOffsetLocations: [{ group: 0, binding: 4 }]
    });
    const duplicateDynamic = compileBindingLayoutPlan(source, {
      dynamicOffsetLocations: [
        { group: 0, binding: 1 },
        { group: 0, binding: 1 }
      ]
    });

    expect(duplicate).toMatchObject({ kind: 'invalid', diagnostic: { code: 'duplicate-group' } });
    expect(nonBufferDynamic).toMatchObject({
      kind: 'invalid',
      diagnostic: { code: 'invalid-dynamic-offset' }
    });
    expect(duplicateDynamic).toMatchObject({
      kind: 'invalid',
      diagnostic: { code: 'invalid-options' }
    });
  });
});

function manifest(): ShaderBindingManifest {
  const buffer = {
    name: 'material',
    shaderAbiVersion: 1,
    target: 'wgsl' as const,
    addressSpace: 'uniform' as const,
    access: 'read' as const,
    policy: 'wgsl-uniform' as const,
    byteSize: 64,
    alignment: 16,
    fields: [],
    layoutHash: 'buffer-layout'
  };
  return {
    shaderAbiVersion: 1,
    groups: [
      {
        group: 2,
        visibility: ['compute'],
        entries: [
          {
            kind: 'storage-buffer',
            group: 2,
            binding: 3,
            name: 'particles',
            bufferLayoutName: 'particles'
          }
        ]
      },
      {
        group: 0,
        visibility: ['fragment', 'vertex'],
        entries: [
          {
            kind: 'texture',
            group: 0,
            binding: 4,
            name: 'albedo',
            viewDimension: '2d',
            sampleType: 'float',
            multisampled: false
          },
          {
            kind: 'uniform-buffer',
            group: 0,
            binding: 1,
            name: 'material',
            bufferLayoutName: 'material'
          }
        ]
      }
    ],
    buffers: [
      buffer,
      {
        ...buffer,
        name: 'particles',
        addressSpace: 'storage',
        access: 'read_write',
        layoutHash: 'storage-layout'
      }
    ],
    vertexInputs: [],
    fragmentOutputs: [],
    layoutHash: 'authoring-layout'
  };
}

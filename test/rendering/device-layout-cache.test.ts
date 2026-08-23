import { describe, expect, test, vi } from 'vitest';
import { DeviceLayoutCache, LayoutCache, type BindingLayoutPlan } from '../../src/rendering';
import { NullDevice } from '../../src/rhi';

describe('DeviceLayoutCache', () => {
  test('realizes sparse group coordinates once and reuses the exact device entry', () => {
    const plan = fixture();
    const layoutEntry = new LayoutCache().resolve({
      plan,
      layoutRevision: 2,
      featurePolicyHash: 'policy:a',
      target: 'webgpu',
      deviceGeneration: 1
    }).entry;
    const device = new NullDevice();
    const createGroup = vi.spyOn(device, 'createBindGroupLayout');
    const createPipelineLayout = vi.spyOn(device, 'createPipelineLayout');
    const cache = new DeviceLayoutCache();

    const first = cache.resolve(layoutEntry, device);
    const second = cache.resolve(layoutEntry, device);

    expect(first.status).toBe('miss');
    expect(second.status).toBe('hit');
    const firstLayout = requireReady(first);
    const secondLayout = requireReady(second);
    expect(secondLayout).toBe(firstLayout);
    expect(firstLayout.bindGroupLayouts).toHaveLength(3);
    expect(firstLayout.bindGroupLayouts[1]?.descriptor.entries).toEqual([]);
    expect(createGroup).toHaveBeenCalledTimes(3);
    expect(createPipelineLayout).toHaveBeenCalledTimes(1);
  });

  test('isolates native layouts by request identity and actual device generation', () => {
    const plan = fixture();
    const cpuCache = new LayoutCache();
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const cache = new DeviceLayoutCache();
    const entry = cpuCache.resolve({
      plan,
      layoutRevision: 1,
      featurePolicyHash: 'policy:a',
      target: 'webgpu',
      deviceGeneration: firstDevice.generation
    }).entry;

    const first = requireReady(cache.resolve(entry, firstDevice));
    expect(() => cache.resolve(entry, secondDevice)).toThrow(/device generation/i);

    const nextPolicy = cpuCache.resolve({
      plan,
      layoutRevision: 1,
      featurePolicyHash: 'policy:b',
      target: 'webgpu',
      deviceGeneration: firstDevice.generation
    }).entry;
    expect(requireReady(cache.resolve(nextPolicy, firstDevice))).not.toBe(first);
  });

  test('returns typed unsupported lowering without creating RHI objects', () => {
    const device = new NullDevice();
    const entry = new LayoutCache().resolve({
      plan: storageFixture(),
      layoutRevision: 1,
      featurePolicyHash: 'policy:a',
      target: 'webgl2',
      deviceGeneration: device.generation
    }).entry;
    const createGroup = vi.spyOn(device, 'createBindGroupLayout');

    const result = new DeviceLayoutCache().resolve(entry, device);

    expect(result).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'storage-buffer-unsupported' }
    });
    expect(createGroup).not.toHaveBeenCalled();
  });

  test('disposes partially created group layouts when pipeline-layout creation fails', () => {
    const device = new NullDevice();
    const entry = new LayoutCache().resolve({
      plan: fixture(),
      layoutRevision: 1,
      featurePolicyHash: 'policy:a',
      target: 'webgpu',
      deviceGeneration: device.generation
    }).entry;
    const created = [] as ReturnType<NullDevice['createBindGroupLayout']>[];
    vi.spyOn(device, 'createBindGroupLayout').mockImplementation((descriptor) => {
      const layout = NullDevice.prototype.createBindGroupLayout.call(device, descriptor);
      created.push(layout);
      return layout;
    });
    vi.spyOn(device, 'createPipelineLayout').mockImplementation(() => {
      throw new Error('native layout creation failed');
    });

    expect(() => new DeviceLayoutCache().resolve(entry, device)).toThrow(
      'native layout creation failed'
    );
    expect(created).toHaveLength(3);
    expect(created.every((layout) => layout.state === 'disposed')).toBe(true);
  });
});

function fixture(): BindingLayoutPlan {
  return {
    id: 'layout:sparse' as BindingLayoutPlan['id'],
    sourceLayoutHash: 'shader-layout:sparse',
    shaderAbiVersion: 1,
    groups: [
      {
        group: 0,
        visibility: ['vertex'],
        bindings: [uniformBinding(0)]
      },
      {
        group: 2,
        visibility: ['fragment'],
        bindings: [uniformBinding(2)]
      }
    ],
    dynamicOffsetOrder: [],
    backendRequirements: [],
    hash: 'layout:sparse:hash'
  };
}

function storageFixture(): BindingLayoutPlan {
  return {
    ...fixture(),
    id: 'layout:storage' as BindingLayoutPlan['id'],
    groups: [
      {
        group: 0,
        visibility: ['vertex'],
        bindings: [
          {
            kind: 'storage-buffer',
            group: 0,
            binding: 0,
            access: 'read',
            minimumByteSize: 64,
            bufferLayoutHash: 'buffer:storage',
            dynamicOffset: false
          }
        ]
      }
    ],
    hash: 'layout:storage:hash'
  };
}

function uniformBinding(group: number) {
  return {
    kind: 'uniform-buffer' as const,
    group,
    binding: 0,
    access: 'read' as const,
    minimumByteSize: 64,
    bufferLayoutHash: `buffer:${group}`,
    dynamicOffset: false
  };
}

function requireReady(result: ReturnType<DeviceLayoutCache['resolve']>) {
  if (result.status === 'unsupported') throw new Error(result.diagnostic.message);
  return result.layout;
}

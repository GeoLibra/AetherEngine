import { describe, expect, test, vi } from 'vitest';
import {
  DeviceLayoutCache,
  LayoutCache,
  MaterialBindGroupCache,
  createBindingKey,
  prepareMaterialBindGroups,
  type BindingLayoutPlan,
  type MaterialBindGroupResourceResolver
} from '../../src/rendering';
import { NullDevice } from '../../src/rhi';
import type { RHISubmission, SubmissionResult } from '../../src/rhi/contracts';

const BUFFER_USAGE_UNIFORM = 8;
const TEXTURE_USAGE_BINDING = 4;

describe('prepareMaterialBindGroups', () => {
  test('builds complete sparse group descriptors and preserves dynamic-offset order', () => {
    const fixture = createFixture();

    const result = prepareMaterialBindGroups(fixture.input);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.prepared.groups).toHaveLength(3);
    expect(result.prepared.groups[1]?.descriptor.entries).toEqual([]);
    expect(result.prepared.groups[0]?.descriptor.entries[0]?.resource).toMatchObject({
      buffer: fixture.buffer,
      offset: 0,
      size: 64
    });
    expect(result.prepared.groups[2]?.descriptor.entries.map(({ binding }) => binding)).toEqual([
      0, 1
    ]);
    expect(result.prepared.dynamicOffsets).toEqual([256]);
  });

  test('returns typed skips for missing resources and canonical layout mismatch', () => {
    const fixture = createFixture();
    const missing: MaterialBindGroupResourceResolver = {
      ...fixture.input.resolver,
      resolveTextureView: () => undefined
    };

    expect(prepareMaterialBindGroups({ ...fixture.input, resolver: missing })).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-resource-missing', group: 2, binding: 0 }
    });
    expect(
      prepareMaterialBindGroups({
        ...fixture.input,
        bindingKey: createBindingKey({
          ...fixture.input.bindingKey.parts,
          bindingLayoutHash: 'another-layout'
        })
      })
    ).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-layout-incompatible' }
    });
  });

  test('rejects stale or disposed RHI handles before device creation', () => {
    const fixture = createFixture();
    fixture.textureView.dispose();

    expect(prepareMaterialBindGroups(fixture.input)).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-resource-stale', group: 2, binding: 0 }
    });
  });

  test('returns typed stale when a device layout has already been disposed', () => {
    const fixture = createFixture();
    fixture.input.deviceLayout.bindGroupLayouts[0]?.dispose();

    expect(prepareMaterialBindGroups(fixture.input)).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-device-generation-stale' }
    });
  });

  test('requires the device layout realization to identify the same canonical plan', () => {
    const fixture = createFixture();
    const identity = fixture.input.deviceLayout as unknown as Readonly<{
      bindingLayoutId: string;
      bindingLayoutHash: string;
    }>;

    expect(identity.bindingLayoutId).toBe(fixture.input.plan.id);
    expect(identity.bindingLayoutHash).toBe(fixture.input.plan.hash);
    expect(
      prepareMaterialBindGroups({
        ...fixture.input,
        deviceLayout: {
          ...fixture.input.deviceLayout,
          bindingLayoutHash: 'another-canonical-layout'
        } as typeof fixture.input.deviceLayout
      })
    ).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-layout-incompatible' }
    });
  });

  test('returns typed diagnostics for malformed buffer handles and non-finite ranges', () => {
    const fixture = createFixture();
    const missingBuffer = {
      ...fixture.input.resolver,
      resolveBuffer: () => ({ buffer: null, offset: 0, size: 64 })
    } as unknown as MaterialBindGroupResourceResolver;
    const invalidRange = {
      ...fixture.input.resolver,
      resolveBuffer: () => ({ buffer: fixture.buffer, offset: Number.NaN, size: Number.NaN })
    } as unknown as MaterialBindGroupResourceResolver;

    expect(prepareMaterialBindGroups({ ...fixture.input, resolver: missingBuffer })).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-resource-missing', group: 0, binding: 0 }
    });
    expect(prepareMaterialBindGroups({ ...fixture.input, resolver: invalidRange })).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-buffer-range-invalid', group: 0, binding: 0 }
    });
  });

  test('rejects a malformed resolver that returns the wrong RHI resource kind', () => {
    const fixture = createFixture();
    const malformed = {
      ...fixture.input.resolver,
      resolveSampler: () => fixture.textureView
    } as unknown as MaterialBindGroupResourceResolver;

    expect(prepareMaterialBindGroups({ ...fixture.input, resolver: malformed })).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'binding-resource-kind-mismatch', group: 2, binding: 1 }
    });
  });
});

describe('MaterialBindGroupCache', () => {
  test('creates one complete set and reuses exact binding identity hits', () => {
    const fixture = createFixture();
    const preparation = prepareMaterialBindGroups(fixture.input);
    if (preparation.status !== 'ready') throw new Error(preparation.diagnostic.message);
    const createBindGroup = vi.spyOn(fixture.device, 'createBindGroup');
    const cache = new MaterialBindGroupCache();

    const first = cache.resolve(preparation.prepared, fixture.device);
    const second = cache.resolve(preparation.prepared, fixture.device);

    expect(first.status).toBe('miss');
    expect(second.status).toBe('hit');
    expect(second.bindingSet).toBe(first.bindingSet);
    expect(first.bindingSet.bindGroups).toHaveLength(3);
    expect(createBindGroup).toHaveBeenCalledTimes(3);
    first.lease.release();
    second.lease.release();
  });

  test('disposes owned bind groups on invalidation and partial creation failure', () => {
    const fixture = createFixture();
    const preparation = prepareMaterialBindGroups(fixture.input);
    if (preparation.status !== 'ready') throw new Error(preparation.diagnostic.message);
    const cache = new MaterialBindGroupCache();
    const realized = cache.resolve(preparation.prepared, fixture.device);

    expect(cache.invalidateDeviceGeneration(fixture.device.generation)).toBe(1);
    expect(realized.bindingSet.bindGroups.every((group) => group.state === 'live')).toBe(true);
    realized.lease.release();
    expect(realized.bindingSet.bindGroups.every((group) => group.state === 'disposed')).toBe(true);

    const secondFixture = createFixture();
    const secondPreparation = prepareMaterialBindGroups(secondFixture.input);
    if (secondPreparation.status !== 'ready') throw new Error(secondPreparation.diagnostic.message);
    const created = [] as ReturnType<NullDevice['createBindGroup']>[];
    const nativeCreate = secondFixture.device.createBindGroup.bind(secondFixture.device);
    vi.spyOn(secondFixture.device, 'createBindGroup').mockImplementation((descriptor) => {
      if (created.length === 1) throw new Error('native bind group failure');
      const group = nativeCreate(descriptor);
      created.push(group);
      return group;
    });

    expect(() =>
      new MaterialBindGroupCache().resolve(secondPreparation.prepared, secondFixture.device)
    ).toThrow('native bind group failure');
    expect(created).toHaveLength(1);
    expect(created[0]?.state).toBe('disposed');
  });

  test('defers device-loss disposal until a retained submission becomes terminal', async () => {
    const fixture = createFixture();
    const preparation = prepareMaterialBindGroups(fixture.input);
    if (preparation.status !== 'ready') throw new Error(preparation.diagnostic.message);
    const cache = new MaterialBindGroupCache();
    const resolution = cache.resolve(preparation.prepared, fixture.device);
    const submission = deferredSubmission(20);
    resolution.lease.retain(submission.value);

    cache.invalidateDeviceGeneration(fixture.device.generation);
    resolution.lease.release();

    expect(() => cache.resolve(preparation.prepared, fixture.device)).toThrow(
      /device generation has been invalidated/i
    );
    expect(resolution.bindingSet.bindGroups.every((group) => group.state === 'live')).toBe(true);
    submission.resolve({ status: 'device-lost' });
    await submission.value.done;
    await Promise.resolve();
    expect(resolution.bindingSet.bindGroups.every((group) => group.state === 'disposed')).toBe(
      true
    );
  });
});

function deferredSubmission(id: number) {
  let status: RHISubmission['status'] = 'pending';
  let resolvePromise!: (result: SubmissionResult) => void;
  const done = new Promise<SubmissionResult>((resolve) => {
    resolvePromise = resolve;
  });
  const value: RHISubmission = {
    id,
    get status() {
      return status;
    },
    done
  };
  return {
    value,
    resolve(result: SubmissionResult) {
      status = result.status;
      resolvePromise(result);
    }
  };
}

function createFixture() {
  const device = new NullDevice();
  const plan = bindingPlan();
  const lowering = new LayoutCache().resolve({
    plan,
    layoutRevision: 1,
    featurePolicyHash: 'policy:a',
    target: 'webgpu',
    deviceGeneration: device.generation
  }).entry;
  const layoutResult = new DeviceLayoutCache().resolve(lowering, device);
  if (layoutResult.status === 'unsupported') throw new Error(layoutResult.diagnostic.message);
  const buffer = device.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
  const texture = device.createTexture({
    size: { width: 1, height: 1 },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_BINDING
  });
  const textureView = texture.createView();
  const sampler = device.createSampler();
  const bindingKey = createBindingKey({
    bindingLayoutHash: plan.hash,
    resources: [
      {
        group: 2,
        binding: 0,
        assetId: 'texture:a',
        assetPayloadVersion: 1,
        resourceGeneration: 3
      },
      {
        group: 2,
        binding: 1,
        assetId: 'sampler:a',
        assetPayloadVersion: 1,
        resourceGeneration: 4
      }
    ],
    bufferAllocationGeneration: 5,
    ringGeneration: 6,
    dynamicOffsets: [256],
    deviceGeneration: device.generation
  });
  const resolver: MaterialBindGroupResourceResolver = {
    deviceGeneration: device.generation,
    resolveTextureView: () => textureView,
    resolveSampler: () => sampler,
    resolveBuffer: () => ({ buffer, offset: 0, size: 64 })
  };
  return {
    device,
    buffer,
    textureView,
    input: {
      plan,
      deviceLayout: layoutResult.layout,
      bindingKey,
      resolver
    }
  };
}

function bindingPlan(): BindingLayoutPlan {
  return {
    id: 'binding-layout:material' as BindingLayoutPlan['id'],
    sourceLayoutHash: 'shader-layout:material',
    shaderAbiVersion: 1,
    groups: [
      {
        group: 0,
        visibility: ['vertex'],
        bindings: [
          {
            kind: 'uniform-buffer',
            group: 0,
            binding: 0,
            access: 'read',
            minimumByteSize: 64,
            bufferLayoutHash: 'buffer:material',
            dynamicOffset: true
          }
        ]
      },
      {
        group: 2,
        visibility: ['fragment'],
        bindings: [
          {
            kind: 'texture',
            group: 2,
            binding: 0,
            viewDimension: '2d',
            sampleType: 'float',
            multisampled: false
          },
          {
            kind: 'sampler',
            group: 2,
            binding: 1,
            samplerType: 'filtering'
          }
        ]
      }
    ],
    dynamicOffsetOrder: [{ group: 0, binding: 0 }],
    backendRequirements: [],
    hash: 'binding-layout:material:hash'
  };
}

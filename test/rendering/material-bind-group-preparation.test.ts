import { describe, expect, test } from 'vitest';
import {
  DeviceLayoutCache,
  LayoutCache,
  createBindingKey,
  prepareMaterialBindGroups,
  type BindingLayoutPlan,
  type MaterialBindGroupResourceResolver
} from '../../src/rendering';
import { NullDevice } from '../../src/rhi';

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

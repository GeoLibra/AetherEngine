import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  BuiltInFeature,
  BuiltInFeatureImplementation,
  BuiltInHostService,
  FeatureImplementationRegistry,
  ZERO_RESOURCE_BUDGET,
  createCpuBoundedLightListImplementation,
  createWebGlFragmentLightListImplementation,
  createWebGpuComputeLightListImplementation,
  resolveFeaturePolicy,
  type CpuLightListResult,
  type DeviceCapabilities,
  type LightReceiver,
  type PreparedLight,
  type RHIBackend
} from '../../src';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';
import { runLightingReference } from '../../benchmark/lighting-shadow/scenario';

const root = resolve('test/feature-policy/light-list-build');
const fixture = json<{
  viewLayerMask: number;
  capacity: { maxDirectionalLights: number; maxLightsPerReceiver: number; maxLightIndices: number };
  lights: PreparedLight[];
  receivers: LightReceiver[];
}>('fixtures/basic.json');
const expected = json<unknown>('expected/basic.json');

describe('LightListBuild cpu-bounded semantic fixture', () => {
  test.each([
    ['webgpu', BuiltInFeatureImplementation.WebGpuComputeLightList, 'native'],
    ['webgl2', BuiltInFeatureImplementation.WebGlFragmentLightList, 'emulated']
  ] as const)(
    'selects the %s GPU implementation when its exact capabilities are available',
    (backend, implementationId, support) => {
      const implementations = [
        createWebGpuComputeLightListImplementation({
          capacity: fixture.capacity,
          estimatedBudget: ZERO_RESOURCE_BUDGET
        }),
        createWebGlFragmentLightListImplementation({
          capacity: fixture.capacity,
          estimatedBudget: ZERO_RESOURCE_BUDGET,
          maxTextureDimension2D: 4096
        }),
        createCpuBoundedLightListImplementation({
          capacity: fixture.capacity,
          estimatedBudget: ZERO_RESOURCE_BUDGET
        })
      ];
      const result = resolveFeaturePolicy({
        schemaVersion: 1,
        revision: 1,
        profileId: 'fixture',
        deviceGeneration: 1,
        capabilities: gpuCapabilities(backend),
        hostServices: new Set([BuiltInHostService.MainCpu]),
        budget: ZERO_RESOURCE_BUDGET,
        requests: [
          {
            feature: BuiltInFeature.LightListBuild,
            semanticContract: 'aether.light-list-build@1',
            required: true,
            priority: 1
          }
        ],
        implementations
      });
      expect(result.snapshot.decisions.get(BuiltInFeature.LightListBuild)).toMatchObject({
        implementation: implementationId,
        support
      });
    }
  );

  test.each(['webgpu', 'webgl2'] as const)(
    'selects the same implementation from %s capability facts',
    (backend) => {
      const registry = new FeatureImplementationRegistry();
      registry.register(
        createCpuBoundedLightListImplementation({
          capacity: fixture.capacity,
          estimatedBudget: ZERO_RESOURCE_BUDGET
        })
      );
      const result = resolveFeaturePolicy({
        schemaVersion: 1,
        revision: 1,
        profileId: 'fixture',
        deviceGeneration: 1,
        capabilities: capabilities(backend),
        hostServices: new Set([BuiltInHostService.MainCpu]),
        budget: ZERO_RESOURCE_BUDGET,
        requests: [
          {
            feature: BuiltInFeature.LightListBuild,
            semanticContract: 'aether.light-list-build@1',
            required: true,
            priority: 1
          }
        ],
        implementations: registry.snapshot()
      });
      expect(result.snapshot.decisions.get(BuiltInFeature.LightListBuild)).toMatchObject({
        support: 'fallback',
        implementation: BuiltInFeatureImplementation.CpuBoundedLightList
      });
    }
  );

  test('executes the existing bounded builder and matches the shared normalized oracle', async () => {
    const implementation = createCpuBoundedLightListImplementation({
      capacity: fixture.capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    });
    const prepared = await implementation.prepare({
      capabilities: capabilities('webgpu'),
      hostServices: new Set([BuiltInHostService.MainCpu]),
      profileId: 'fixture',
      deviceGeneration: 1,
      budget: ZERO_RESOURCE_BUDGET
    });
    const result = implementation.execute(prepared, {
      viewLayerMask: fixture.viewLayerMask,
      lights: fixture.lights,
      receivers: fixture.receivers
    });
    expect(normalize(result)).toEqual(expected);
    const reference = runLightingReference({
      lights: fixture.lights,
      receivers: fixture.receivers,
      capacity: fixture.capacity
    });
    expect(normalize(result)).toMatchObject({
      directionalEntities: reference.directionalEntities,
      receivers: reference.receivers
    });
  });
});

function capabilities(backend: RHIBackend): DeviceCapabilities {
  return createCapabilitySnapshot({
    backend,
    features: new Map(),
    limits: {},
    formats: new Map(),
    queues: [{ role: 'graphics', status: 'native' }]
  });
}

function gpuCapabilities(backend: 'webgpu' | 'webgl2'): DeviceCapabilities {
  const format = {
    sample: true,
    filter: false,
    render: true,
    blend: false,
    storage: false,
    copySrc: true,
    copyDst: true,
    sampleCounts: [1]
  };
  return createCapabilitySnapshot({
    backend,
    features: new Map(
      backend === 'webgpu'
        ? [
            ['compute', { status: 'native' as const }],
            ['storage-buffer', { status: 'native' as const }]
          ]
        : [
            ['compute', { status: 'unsupported' as const }],
            ['storage-buffer', { status: 'unsupported' as const }]
          ]
    ),
    limits: backend === 'webgl2' ? { maxColorAttachments: 4, maxTextureDimension2D: 4096 } : {},
    formats: backend === 'webgl2' ? new Map([['rgba32uint', format]]) : new Map(),
    queues:
      backend === 'webgpu'
        ? [
            { role: 'graphics', status: 'native' },
            { role: 'compute', status: 'native' }
          ]
        : [{ role: 'graphics', status: 'native' }]
  });
}

function normalize(result: CpuLightListResult) {
  return {
    directionalEntities: result.globalDirectionalLightIndices.map(
      (index) => result.orderedLights[index]!.entity
    ),
    receivers: result.headers.map((header) => ({
      receiver: header.receiver,
      lightEntities: result.lightIndices
        .slice(header.offset, header.offset + header.count)
        .map((index) => result.orderedLights[index]!.entity),
      overflowed: header.overflowed
    })),
    overflowed: result.overflowed,
    fallback: result.fallback
  };
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}

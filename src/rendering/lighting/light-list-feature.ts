import {
  featureId,
  hostServiceId,
  implementationId,
  snapshotResourceBudget,
  type ResourceBudget,
  type RuntimeFeatureImplementation
} from '../../feature-policy';
import { buildCpuLightLists } from './light-list';
import type {
  CpuLightListCapacity,
  CpuLightListResult,
  LightReceiver,
  PreparedLight
} from './types';

export const BuiltInFeature = Object.freeze({
  LightListBuild: featureId('aether.rendering.light-list-build')
} as const);

export const BuiltInFeatureImplementation = Object.freeze({
  CpuBoundedLightList: implementationId('cpu-bounded')
} as const);

export const BuiltInHostService = Object.freeze({
  MainCpu: hostServiceId('main-cpu')
} as const);

export interface CpuBoundedLightListFrameInput {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
}

export interface CpuBoundedLightListImplementationOptions {
  readonly capacity: CpuLightListCapacity;
  readonly estimatedBudget: ResourceBudget;
}

export function createCpuBoundedLightListImplementation(
  options: CpuBoundedLightListImplementationOptions
): RuntimeFeatureImplementation<
  CpuLightListCapacity,
  CpuBoundedLightListFrameInput,
  CpuLightListResult
> {
  const capacity = snapshotCapacity(options.capacity);
  const estimatedBudget = snapshotResourceBudget(options.estimatedBudget);
  return {
    kind: 'runtime' as const,
    feature: BuiltInFeature.LightListBuild,
    id: BuiltInFeatureImplementation.CpuBoundedLightList,
    version: 1,
    support: 'fallback' as const,
    semanticContract: 'aether.light-list-build@1',
    requirements: [
      {
        kind: 'queue' as const,
        role: 'graphics' as const,
        statuses: ['native', 'emulated'] as const
      },
      { kind: 'service' as const, service: BuiltInHostService.MainCpu }
    ],
    dependencies: [],
    conflicts: [],
    priority: 0,
    quality: {
      tier: 'cpu-bounded',
      rank: 0,
      notes: ['Capacity and deterministic truncation are explicit.']
    },
    estimate: () => estimatedBudget,
    prepare: async () => capacity,
    dispose: () => undefined,
    execute: (prepared: CpuLightListCapacity, frame: CpuBoundedLightListFrameInput) =>
      buildCpuLightLists({
        viewLayerMask: frame.viewLayerMask,
        lights: frame.lights,
        receivers: frame.receivers,
        capacity: prepared
      })
  };
}

function snapshotCapacity(capacity: CpuLightListCapacity): CpuLightListCapacity {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CPU bounded light-list ${name} must be a non-negative integer.`);
    }
  }
  return { ...capacity };
}

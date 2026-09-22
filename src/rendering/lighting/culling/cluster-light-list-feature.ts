import {
  featureId,
  implementationId,
  snapshotResourceBudget,
  type RenderFeatureImplementation,
  type ResourceBudget
} from '../../../feature-policy';
import type { RenderGraphBuilder } from '../../../render-graph';
import type { ClusterCapacity } from '../types';
import {
  contributeWebGpuClusterLightList,
  type PreparedWebGpuClusterLightListRecorder,
  type WebGpuClusterLightListInput,
  type WebGpuClusterLightListOutput
} from './webgpu-cluster-light-list-recorder';

/** Feature-policy identity for the forward clustered-light assignment stage. */
export const ClusterLightListFeature = featureId('aether.rendering.cluster-light-list-build');
export const ClusterLightListImplementation = Object.freeze({
  WebGpuCompute: implementationId('webgpu-compute')
} as const);

export interface WebGpuClusterLightListBuildContext {
  readonly viewId: string;
  readonly graph: RenderGraphBuilder;
  readonly input: WebGpuClusterLightListInput;
  readonly clusterCount: number;
  readonly recorder: PreparedWebGpuClusterLightListRecorder;
  publish(output: WebGpuClusterLightListOutput): void;
}

export interface WebGpuClusterLightListImplementationOptions {
  readonly capacity: ClusterCapacity;
  readonly estimatedBudget: ResourceBudget;
}

/**
 * Creates the capability-gated WebGPU clustered-light graph contribution. It is deliberately a
 * separate FeaturePolicy decision from receiver light lists: consumers must opt in to the
 * cluster ABI instead of silently interpreting one output as the other.
 */
export function createWebGpuClusterLightListImplementation(
  options: WebGpuClusterLightListImplementationOptions
): RenderFeatureImplementation<ClusterCapacity, WebGpuClusterLightListBuildContext> {
  const capacity = snapshotCapacity(options.capacity);
  const estimatedBudget = snapshotResourceBudget(options.estimatedBudget);
  return {
    kind: 'render',
    feature: ClusterLightListFeature,
    id: ClusterLightListImplementation.WebGpuCompute,
    version: 1,
    support: 'native',
    semanticContract: 'aether.cluster-light-list-build@1',
    requirements: [
      { kind: 'feature', feature: 'compute', statuses: ['native'] },
      { kind: 'feature', feature: 'storage-buffer', statuses: ['native'] },
      { kind: 'queue', role: 'compute', statuses: ['native'] }
    ],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['shader-pipeline'],
    priority: 20,
    quality: {
      tier: 'gpu-compute',
      rank: 20,
      notes: ['Deterministic clustered light assignment with bounded storage outputs.']
    },
    estimate: () => estimatedBudget,
    prepare: async () => capacity,
    dispose: () => undefined,
    contribute(prepared, context) {
      if (!context.viewId.trim()) throw new Error('Cluster light-list viewId must be non-empty.');
      contributeWebGpuClusterLightList(
        context.graph,
        context.input,
        context.clusterCount,
        prepared,
        context.recorder,
        context.publish
      );
    }
  };
}

function snapshotCapacity(capacity: ClusterCapacity): ClusterCapacity {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Cluster light-list ${name} must be a non-negative integer.`);
    }
  }
  return Object.freeze({ ...capacity });
}

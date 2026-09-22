import type { Vec3 } from '../../../math/types';
import type { PreparedLight } from './light';
import type { RHIBuffer } from '../../../rhi/contracts';

export type ClusterDepthPolicy = 'finite' | 'infinite';

/** Deterministic depth slicing shape for the cluster grid Z axis. */
export type ClusterSliceShape = 'logarithmic' | 'uniform';

export interface ClusterSlicingPolicy {
  readonly depth: ClusterDepthPolicy;
  readonly shape: ClusterSliceShape;
  /** Uniform/log blend used by the finite policy; clamped to [0, 1]. */
  readonly lambda: number;
}

export interface ClusterCapacity {
  readonly maxDirectionalLights: number;
  readonly maxLightsPerCluster: number;
  readonly maxClusterIndices: number;
}

/** One Z slice of the cluster grid expressed as a camera-depth interval. */
export interface ClusterSlice {
  readonly index: number;
  readonly near: number;
  readonly far: number;
}

/** World-space conservative AABB covering one cell of the cluster grid. */
export interface ClusterAABB {
  readonly index: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly slice: number;
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Immutable cluster grid derived from a view frustum, viewport, and depth slicing policy.
 * `clusterCount = tilesX * tilesY * slices.length`; cluster index layout is
 * `(slice * tilesY + tileY) * tilesX + tileX`.
 */
export interface ClusterGrid {
  readonly viewId: string;
  readonly projectionRevision: number;
  readonly viewTransformRevision: number;
  readonly deviceGeneration: number;
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly cameraNear: number;
  readonly cameraFar: number;
  readonly slices: readonly ClusterSlice[];
  readonly depth: number;
  readonly clusterCount: number;
  readonly clusters: readonly ClusterAABB[];
  /** Stable identity; identical inputs always produce the same key. */
  readonly cacheIdentity: string;
}

export interface ClusterLightListHeader {
  readonly cluster: number;
  readonly offset: number;
  readonly count: number;
  readonly overflowed: boolean;
}

export interface ClusterBuildCounters {
  readonly inputLights: number;
  readonly disabledLights: number;
  readonly layerRejectedLights: number;
  readonly clusterCandidates: number;
  readonly intersectionTests: number;
  readonly directionalCount: number;
  readonly directionalTruncated: number;
  readonly emittedIndices: number;
  readonly overflowedClusters: number;
  readonly truncatedIndices: number;
}

/** Deterministic CPU cluster light-list reference matching the design `ClusterBuildResult` contract. */
export interface ClusterBuildResult {
  readonly viewId: string;
  readonly source: 'cpu-upload';
  readonly clusterCount: number;
  readonly lightIndexCount: number;
  readonly capacity: ClusterCapacity;
  readonly overflowed: boolean;
  readonly fallback: 'none' | 'deterministic-truncate';
  readonly orderedLights: readonly PreparedLight[];
  readonly globalDirectionalLightIndices: readonly number[];
  readonly headers: readonly ClusterLightListHeader[];
  readonly lightIndices: readonly number[];
  readonly counters: ClusterBuildCounters;
}

/**
 * Physical WebGPU resources consumed together by a clustered forward shader. The ABI is kept
 * separate from receiver-list inputs: headers are keyed by cluster index, not render entity.
 */
export interface ClusterForwardInputs {
  readonly metadata: RHIBuffer;
  readonly packedLights: RHIBuffer;
  readonly directional: RHIBuffer;
  readonly headers: RHIBuffer;
  readonly indices: RHIBuffer;
  readonly overflow: RHIBuffer;
}

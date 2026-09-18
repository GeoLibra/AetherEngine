import { Vec3Math } from '../../../math';
import type { Vec3 } from '../../../math/types';
import { orderLightsForGpu } from '../core/light';
import {
  LIGHT_LIST_HEADER_WORDS,
  LIGHT_LIST_LIGHT_WORDS,
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES,
  LIGHT_LIST_SHADER_MAX_LIGHTS,
  LIGHT_LIST_SHADER_MAX_RECEIVERS,
  packWebGpuLightListInput
} from './light-list-abi';
import type {
  ClusterAABB,
  ClusterBuildCounters,
  ClusterBuildResult,
  ClusterCapacity,
  ClusterGrid,
  ClusterLightListHeader,
  PreparedLight
} from '../types';

export interface PackedCpuClusterWords {
  readonly lightWords: Uint32Array;
  readonly directionalWords: Uint32Array;
  readonly headerWords: Uint32Array;
  readonly indexWords: Uint32Array;
  readonly overflowWords: Uint32Array;
}

const TERNARY_ITERATIONS = 64;

/**
 * Deterministic sphere-versus-AABB overlap test shared by the point light cluster assignment.
 * Uses the closest-point-on-AABB criterion; the future GPU kernel must reproduce it exactly.
 */
export function sphereIntersectsAABB(center: Vec3, radius: number, bounds: ClusterAABB): boolean {
  if (radius < 0 || !Number.isFinite(radius)) {
    throw new Error('Point light cluster test radius must be a non-negative finite value.');
  }
  const closestX = Math.max(bounds.min[0], Math.min(center[0], bounds.max[0]));
  const closestY = Math.max(bounds.min[1], Math.min(center[1], bounds.max[1]));
  const closestZ = Math.max(bounds.min[2], Math.min(center[2], bounds.max[2]));
  const dx = center[0] - closestX;
  const dy = center[1] - closestY;
  const dz = center[2] - closestZ;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * Conservative deterministic cone-versus-AABB overlap test used by the spot light cluster
 * assignment. The cone is defined by `apex`, a normalized `axis`, a half-angle `outerRadians`,
 * and a finite `range`. Points behind the apex plane or beyond the far-cap plane are rejected
 * first; the remaining case minimizes the squared distance from the AABB to the cone axis over
 * the segment `[0..range]` via a fixed-iteration ternary search (the distance-to-AABB function
 * is convex along the axis) and accepts when the closest distance is inside the cone radius
 * `t * tan(outerRadians)`. This is the CPU reference the future GPU kernel must match exactly.
 */
export function coneIntersectsAABB(input: {
  readonly apex: Vec3;
  readonly axis: Vec3;
  readonly outerRadians: number;
  readonly range: number;
  readonly bounds: ClusterAABB;
}): boolean {
  const { apex, axis, outerRadians, range, bounds } = input;
  if (!Number.isFinite(outerRadians) || outerRadians <= 0 || outerRadians >= Math.PI / 2) {
    throw new Error('Spot light cluster cone half-angle must satisfy 0 < outer < PI/2.');
  }
  if (!Number.isFinite(range) || range <= 0) {
    throw new Error('Spot light cluster cone range must be positive and finite.');
  }
  const normalized = Vec3Math.normalize(axis, 'Spot light cluster axis');
  const apexDot = Vec3Math.dot(apex, normalized);
  const minDot = dotRangeMin(bounds, normalized);
  const maxDot = dotRangeMax(bounds, normalized);
  if (minDot > apexDot + range) return false;
  if (maxDot < apexDot) return false;
  if (!sphereIntersectsAABB(apex, range, bounds)) return false;

  let low = 0;
  let high = range;
  for (let iteration = 0; iteration < TERNARY_ITERATIONS; iteration++) {
    const step = (high - low) / 3;
    const first = low + step;
    const second = high - step;
    if (
      squaredDistanceToAABB(onAxis(apex, normalized, first), bounds) <=
      squaredDistanceToAABB(onAxis(apex, normalized, second), bounds)
    ) {
      high = second;
    } else {
      low = first;
    }
  }
  const t = (low + high) * 0.5;
  const distance = Math.sqrt(squaredDistanceToAABB(onAxis(apex, normalized, t), bounds));
  return distance <= t * Math.tan(outerRadians);
}

/**
 * CPU reference that assigns enabled, layer-matching lights to cluster cells of a view grid.
 * Directional lights go to a small global list; point/spot lights are intersected against each
 * cluster AABB. Caps are enforced per cluster and globally with deterministic stable-order
 * truncation, mirroring the receiver light-list contract.
 */
export function buildCpuClusters(input: {
  readonly viewId: string;
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly grid: ClusterGrid;
  readonly capacity: ClusterCapacity;
}): ClusterBuildResult {
  validateCapacity(input.capacity);
  if (!Number.isSafeInteger(input.viewId.length)) {
    throw new Error('CPU cluster viewId must be a string.');
  }
  validateUint32(input.viewLayerMask, 'viewLayerMask');
  const orderedLights = orderLightsForGpu(input.lights);
  const directional: number[] = [];
  const local: Readonly<{
    light: Exclude<PreparedLight, { readonly kind: 'directional' }>;
    index: number;
  }>[] = [];
  let disabledLights = 0;
  let layerRejectedLights = 0;
  let directionalTruncated = 0;
  for (let index = 0; index < orderedLights.length; index++) {
    const light = orderedLights[index]!;
    if (!light.enabled) {
      disabledLights++;
      continue;
    }
    if ((light.layerMask & input.viewLayerMask) === 0) {
      layerRejectedLights++;
      continue;
    }
    if (light.kind === 'directional') {
      if (directional.length < input.capacity.maxDirectionalLights) directional.push(index);
      else directionalTruncated++;
    } else {
      local.push({ light, index });
    }
  }

  const headers: ClusterLightListHeader[] = [];
  const lightIndices: number[] = [];
  let clusterCandidates = 0;
  let intersectionTests = 0;
  let overflowedClusters = 0;
  let truncatedIndices = 0;
  for (const cluster of input.grid.clusters) {
    const offset = lightIndices.length;
    let count = 0;
    let overflowed = false;
    for (const candidate of local) {
      clusterCandidates++;
      intersectionTests++;
      if (!localLightInfluencesCluster(candidate.light, cluster)) continue;
      if (
        count >= input.capacity.maxLightsPerCluster ||
        lightIndices.length >= input.capacity.maxClusterIndices
      ) {
        overflowed = true;
        truncatedIndices++;
        continue;
      }
      lightIndices.push(candidate.index);
      count++;
    }
    if (overflowed) overflowedClusters++;
    headers.push(Object.freeze({ cluster: cluster.index, offset, count, overflowed }));
  }
  const overflowed = directionalTruncated > 0 || overflowedClusters > 0;
  return Object.freeze({
    viewId: input.viewId,
    source: 'cpu-upload',
    clusterCount: input.grid.clusterCount,
    lightIndexCount: lightIndices.length,
    capacity: Object.freeze({ ...input.capacity }),
    overflowed,
    fallback: overflowed ? 'deterministic-truncate' : 'none',
    orderedLights,
    globalDirectionalLightIndices: Object.freeze(directional),
    headers: Object.freeze(headers),
    lightIndices: Object.freeze(lightIndices),
    counters: Object.freeze({
      inputLights: input.lights.length,
      disabledLights,
      layerRejectedLights,
      clusterCandidates,
      intersectionTests,
      directionalCount: directional.length,
      directionalTruncated,
      emittedIndices: lightIndices.length,
      overflowedClusters,
      truncatedIndices
    } satisfies ClusterBuildCounters)
  });
}

/**
 * Pure packing of the CPU cluster build result into the WebGPU light-list word layout so the
 * existing `decodeWebGpuLightListOutput` contract decodes it byte for byte. This is the ABI
 * equivalence bridge the GPU cluster kernel will consume in the same layout.
 */
export function packCpuClusterListForWebGpu(
  input: {
    readonly viewLayerMask: number;
    readonly lights: readonly PreparedLight[];
  },
  capacity: ClusterCapacity,
  result: ClusterBuildResult
): PackedCpuClusterWords {
  const packedLights = packWebGpuLightListInput({
    viewLayerMask: input.viewLayerMask,
    lights: input.lights,
    receivers: [],
    capacity: {
      maxDirectionalLights: capacity.maxDirectionalLights,
      maxLightsPerReceiver: capacity.maxLightsPerCluster,
      maxLightIndices: capacity.maxClusterIndices
    }
  });
  const lightWords = new Uint32Array(
    LIGHT_LIST_HEADER_WORDS + LIGHT_LIST_SHADER_MAX_LIGHTS * LIGHT_LIST_LIGHT_WORDS
  );
  lightWords.set(packedLights.lights);

  const directionalWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS);
  const directionalSlice = result.globalDirectionalLightIndices.slice(
    0,
    LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS
  );
  directionalWords.set(directionalSlice);

  const headerWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_RECEIVERS * 4);
  const headerCount = Math.min(result.headers.length, LIGHT_LIST_SHADER_MAX_RECEIVERS);
  for (let index = 0; index < headerCount; index++) {
    const header = result.headers[index]!;
    const base = index * 4;
    headerWords[base] = header.cluster;
    headerWords[base + 1] = header.offset;
    headerWords[base + 2] = header.count;
    headerWords[base + 3] = header.overflowed ? 1 : 0;
  }

  const indexWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_INDICES);
  indexWords.set(result.lightIndices.slice(0, LIGHT_LIST_SHADER_MAX_INDICES));

  const overflowWords = new Uint32Array(4);
  const flags = (result.overflowed ? 0xc000_0000 : 0) | (directionalSlice.length & 0x3fff_ffff);
  overflowWords[0] = flags;
  overflowWords[1] = headerCount;
  overflowWords[2] = indexSliceCount(result, capacity);
  overflowWords[3] = 0;
  return Object.freeze({
    lightWords,
    directionalWords,
    headerWords,
    indexWords,
    overflowWords
  });
}

function indexSliceCount(result: ClusterBuildResult, capacity: ClusterCapacity): number {
  return Math.min(
    result.lightIndices.length,
    capacity.maxClusterIndices,
    LIGHT_LIST_SHADER_MAX_INDICES
  );
}

function localLightInfluencesCluster(
  light: Exclude<PreparedLight, { readonly kind: 'directional' }>,
  cluster: ClusterAABB
): boolean {
  if (light.kind === 'point') return sphereIntersectsAABB(light.position, light.range, cluster);
  return coneIntersectsAABB({
    apex: light.position,
    axis: light.direction,
    outerRadians: light.outerRadians,
    range: light.range,
    bounds: cluster
  });
}

function dotRangeMin(bounds: ClusterAABB, axis: Vec3): number {
  return (
    Math.min(bounds.min[0] * axis[0], bounds.max[0] * axis[0]) +
    Math.min(bounds.min[1] * axis[1], bounds.max[1] * axis[1]) +
    Math.min(bounds.min[2] * axis[2], bounds.max[2] * axis[2])
  );
}

function dotRangeMax(bounds: ClusterAABB, axis: Vec3): number {
  return (
    Math.max(bounds.min[0] * axis[0], bounds.max[0] * axis[0]) +
    Math.max(bounds.min[1] * axis[1], bounds.max[1] * axis[1]) +
    Math.max(bounds.min[2] * axis[2], bounds.max[2] * axis[2])
  );
}

function onAxis(apex: Vec3, axis: Vec3, t: number): Vec3 {
  return [apex[0] + axis[0] * t, apex[1] + axis[1] * t, apex[2] + axis[2] * t];
}

function squaredDistanceToAABB(point: Vec3, bounds: ClusterAABB): number {
  const closestX = Math.max(bounds.min[0], Math.min(point[0], bounds.max[0]));
  const closestY = Math.max(bounds.min[1], Math.min(point[1], bounds.max[1]));
  const closestZ = Math.max(bounds.min[2], Math.min(point[2], bounds.max[2]));
  const dx = point[0] - closestX;
  const dy = point[1] - closestY;
  const dz = point[2] - closestZ;
  return dx * dx + dy * dy + dz * dz;
}

function validateCapacity(capacity: ClusterCapacity): void {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CPU cluster ${name} must be a non-negative integer.`);
    }
  }
}

function validateUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`CPU cluster ${name} must be an unsigned 32-bit integer.`);
  }
}

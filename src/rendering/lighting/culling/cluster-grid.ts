import type { Vec3 } from '../../../math/types';
import { computeCascadeSplits } from '../shadow/csm';
import type {
  ClusterAABB,
  ClusterDepthPolicy,
  ClusterGrid,
  ClusterSlice,
  ClusterSliceShape
} from '../types';

export interface ClusterGridInput {
  readonly viewId: string;
  readonly projectionRevision: number;
  readonly deviceGeneration: number;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly cameraNear: number;
  readonly cameraFar: number;
  readonly slicing: Readonly<{
    readonly depth: ClusterDepthPolicy;
    readonly shape: ClusterSliceShape;
    readonly lambda: number;
  }>;
  readonly sliceCount: number;
  readonly inverseViewProjection: ArrayLike<number>;
  readonly tilesX: number;
  readonly tilesY: number;
}

/**
 * Computes the deterministic Z slices of the cluster grid. The finite policy reuses the CSM
 * uniform/log split blend; the infinite policy slices uniformly in the stable remapped depth
 * `d = 1 - near / z` (near-dense logarithmic placement) and clamps the final slice to the
 * explicit grid far bound.
 */
export function computeClusterDepthSlices(input: {
  readonly near: number;
  readonly far: number;
  readonly sliceCount: number;
  readonly policy: ClusterDepthPolicy;
  readonly shape: ClusterSliceShape;
  readonly lambda: number;
}): readonly ClusterSlice[] {
  assertPositiveNearFar(input.near, input.far);
  assertPositiveSliceCount(input.sliceCount);
  if (input.policy === 'finite') {
    const lambda = input.shape === 'uniform' ? 0 : input.lambda;
    const cuts = computeCascadeSplits(input.near, input.far, input.sliceCount, lambda);
    const slices: ClusterSlice[] = [];
    let splitNear = input.near;
    for (let index = 0; index < cuts.length; index++) {
      const splitFar = cuts[index]!;
      slices.push(Object.freeze({ index, near: splitNear, far: splitFar }));
      splitNear = splitFar;
    }
    return Object.freeze(slices);
  }
  const slices: ClusterSlice[] = [];
  let previous = input.near;
  for (let index = 0; index < input.sliceCount; index++) {
    const portion = (index + 1) / input.sliceCount;
    const remapped = index === input.sliceCount - 1 ? input.far : input.near / (1 - portion);
    const far = Math.min(remapped, input.far);
    if (!(far > previous)) {
      throw new Error('Infinite-far cluster depth remap must be strictly increasing.');
    }
    slices.push(Object.freeze({ index, near: previous, far }));
    previous = far;
  }
  return Object.freeze(slices);
}

/**
 * Builds the immutable cluster grid AABBs for a view from its inverse view-projection,
 * viewport, tile layout, and depth slicing policy.
 *
 * Cluster index layout is `(slice * tilesY + tileY) * tilesX + tileX`. Cluster AABBs are
 * conservative world-space boxes covering the frustum cells; identical inputs (including the
 * projection revision and device generation) produce an identical `cacheIdentity`.
 */
export function buildClusterGrid(input: ClusterGridInput): ClusterGrid {
  validateGridInput(input);
  const { width, height } = input.viewport;
  const slices = computeClusterDepthSlices({
    near: input.cameraNear,
    far: input.cameraFar,
    sliceCount: input.sliceCount,
    policy: input.slicing.depth,
    shape: input.slicing.shape,
    lambda: input.slicing.lambda
  });
  const tileWidth = width / input.tilesX;
  const tileHeight = height / input.tilesY;
  const clusters: ClusterAABB[] = [];
  const cameraNear = input.cameraNear;
  const cameraFar = input.cameraFar;
  const inverse = input.inverseViewProjection;
  let index = 0;
  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
    const slice = slices[sliceIndex]!;
    const nearT = (slice.near - cameraNear) / (cameraFar - cameraNear);
    const farT = (slice.far - cameraNear) / (cameraFar - cameraNear);
    for (let tileY = 0; tileY < input.tilesY; tileY++) {
      for (let tileX = 0; tileX < input.tilesX; tileX++) {
        const ndcX0 = ((tileX * tileWidth) / width) * 2 - 1;
        const ndcX1 = (((tileX + 1) * tileWidth) / width) * 2 - 1;
        const ndcY0 = ((tileY * tileHeight) / height) * 2 - 1;
        const ndcY1 = (((tileY + 1) * tileHeight) / height) * 2 - 1;
        const aabb = computeTileSliceAABB(inverse, ndcX0, ndcX1, ndcY0, ndcY1, nearT, farT);
        clusters.push(
          Object.freeze({
            index,
            tileX,
            tileY,
            slice: sliceIndex,
            min: Object.freeze(aabb.min),
            max: Object.freeze(aabb.max)
          })
        );
        index++;
      }
    }
  }
  return Object.freeze({
    viewId: input.viewId,
    projectionRevision: input.projectionRevision,
    deviceGeneration: input.deviceGeneration,
    width,
    height,
    tilesX: input.tilesX,
    tilesY: input.tilesY,
    cameraNear,
    cameraFar,
    slices,
    depth: slices.length,
    clusterCount: clusters.length,
    clusters,
    cacheIdentity: cacheIdentity(input)
  });
}

/** Returns the flat cluster index for the given tile and slice. */
export function clusterIndexOf(
  grid: ClusterGrid,
  tileX: number,
  tileY: number,
  slice: number
): number {
  return (slice * grid.tilesY + tileY) * grid.tilesX + tileX;
}

function validateGridInput(input: ClusterGridInput): void {
  assertPositiveNearFar(input.cameraNear, input.cameraFar);
  assertPositiveSliceCount(input.sliceCount);
  if (!Number.isSafeInteger(input.tilesX) || input.tilesX <= 0) {
    throw new Error('Cluster tilesX must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.tilesY) || input.tilesY <= 0) {
    throw new Error('Cluster tilesY must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.viewport.width) || input.viewport.width <= 0) {
    throw new Error('Cluster viewport width must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.viewport.height) || input.viewport.height <= 0) {
    throw new Error('Cluster viewport height must be a positive integer.');
  }
  if (input.inverseViewProjection.length !== 16) {
    throw new Error('Cluster grid inverse view-projection matrix must contain sixteen values.');
  }
  if (!Number.isSafeInteger(input.projectionRevision) || input.projectionRevision < 0) {
    throw new Error('Cluster grid projection revision must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(input.deviceGeneration) || input.deviceGeneration < 0) {
    throw new Error('Cluster grid device generation must be a non-negative integer.');
  }
}

function computeTileSliceAABB(
  inverse: ArrayLike<number>,
  ndcX0: number,
  ndcX1: number,
  ndcY0: number,
  ndcY1: number,
  nearT: number,
  farT: number
): { readonly min: Vec3; readonly max: Vec3 } {
  const nearCorners = [
    unprojectCorner(inverse, ndcX0, ndcY0, 0),
    unprojectCorner(inverse, ndcX1, ndcY0, 0),
    unprojectCorner(inverse, ndcX1, ndcY1, 0),
    unprojectCorner(inverse, ndcX0, ndcY1, 0)
  ];
  const farCorners = [
    unprojectCorner(inverse, ndcX0, ndcY0, 1),
    unprojectCorner(inverse, ndcX1, ndcY0, 1),
    unprojectCorner(inverse, ndcX1, ndcY1, 1),
    unprojectCorner(inverse, ndcX0, ndcY1, 1)
  ];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < 4; index++) {
    const near = lerp3(nearCorners[index]!, farCorners[index]!, nearT);
    const far = lerp3(nearCorners[index]!, farCorners[index]!, farT);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, near[axis]!, far[axis]!);
      max[axis] = Math.max(max[axis]!, near[axis]!, far[axis]!);
    }
  }
  return Object.freeze({
    min: Object.freeze(min) as Vec3,
    max: Object.freeze(max) as Vec3
  });
}

function unprojectCorner(inverse: ArrayLike<number>, x: number, y: number, depth: number): Vec3 {
  const px = inverse[0]! * x + inverse[4]! * y + inverse[8]! * depth + inverse[12]!;
  const py = inverse[1]! * x + inverse[5]! * y + inverse[9]! * depth + inverse[13]!;
  const pz = inverse[2]! * x + inverse[6]! * y + inverse[10]! * depth + inverse[14]!;
  const pw = inverse[3]! * x + inverse[7]! * y + inverse[11]! * depth + inverse[15]!;
  if (!Number.isFinite(pw) || Math.abs(pw) <= Number.EPSILON) {
    throw new Error('Cluster grid cannot unproject a frustum corner at infinity.');
  }
  return [px / pw, py / pw, pz / pw] as Vec3;
}

function lerp3(near: Vec3, far: Vec3, amount: number): Vec3 {
  return [
    near[0] + (far[0] - near[0]) * amount,
    near[1] + (far[1] - near[1]) * amount,
    near[2] + (far[2] - near[2]) * amount
  ];
}

function assertPositiveNearFar(near: number, far: number): void {
  if (!Number.isFinite(near) || near <= 0) {
    throw new Error('Cluster grid near must be positive and finite.');
  }
  if (!Number.isFinite(far) || far <= near) {
    throw new Error('Cluster grid far must be finite and greater than near.');
  }
}

function assertPositiveSliceCount(sliceCount: number): void {
  if (!Number.isSafeInteger(sliceCount) || sliceCount <= 0) {
    throw new Error('Cluster slice count must be a positive integer.');
  }
}

function cacheIdentity(input: ClusterGridInput): string {
  return [
    input.viewId,
    input.projectionRevision,
    input.deviceGeneration,
    input.viewport.width,
    input.viewport.height,
    input.tilesX,
    input.tilesY,
    input.cameraNear,
    input.cameraFar,
    input.slicing.depth,
    input.slicing.shape,
    input.slicing.lambda,
    input.sliceCount
  ].join('|');
}

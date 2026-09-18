import { Mat4, Vec3Math } from '../../../math';
import { STANDARD_DEPTH } from '../../../math/depth';
import type { Vec3 } from '../../../math/types';
import { stableLightBasis } from './csm';

/** Returns the first cascade containing `viewDepth`, or undefined outside shadow distance. */
export function selectShadowCascade(
  viewDepth: number,
  splitDepths: readonly number[]
): number | undefined {
  if (!Number.isFinite(viewDepth) || viewDepth < 0) {
    throw new Error('Shadow receiver view depth must be finite and non-negative.');
  }
  if (
    splitDepths.length === 0 ||
    splitDepths.some(
      (split, index) =>
        !Number.isFinite(split) || split <= 0 || (index > 0 && split <= splitDepths[index - 1]!)
    )
  ) {
    throw new Error('Shadow cascade splits must be finite, positive, and strictly increasing.');
  }
  const cascade = splitDepths.findIndex((split) => viewDepth <= split);
  return cascade < 0 ? undefined : cascade;
}

/** Computes constant plus slope-scaled receiver bias in normalized shadow depth units. */
export function computeShadowDepthBias(
  normalDotLight: number,
  constantBias: number,
  slopeBias: number
): number {
  if (![normalDotLight, constantBias, slopeBias].every(Number.isFinite)) {
    throw new Error('Shadow bias inputs must be finite.');
  }
  if (constantBias < 0 || slopeBias < 0) {
    throw new Error('Shadow bias terms must be non-negative.');
  }
  return constantBias + slopeBias * (1 - Math.max(0, Math.min(1, normalDotLight)));
}

/** CPU oracle for a less-equal percentage-closer filtered depth comparison. */
export function visibilityFromDepthSamples(
  receiverDepth: number,
  sampledDepths: readonly number[]
): number {
  if (!Number.isFinite(receiverDepth)) throw new Error('Shadow receiver depth must be finite.');
  if (sampledDepths.some((depth) => !Number.isFinite(depth))) {
    throw new Error('Shadow depth samples must be finite.');
  }
  if (sampledDepths.length === 0) return 1;
  let visible = 0;
  for (const depth of sampledDepths) visible += receiverDepth <= depth ? 1 : 0;
  return visible / sampledDepths.length;
}

export interface SpotShadowProjectionInput {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly range: number;
  readonly outerRadians: number;
  readonly near?: number;
  readonly far?: number;
}

export interface ShadowSpaceSample {
  readonly uv: Readonly<[number, number]>;
  readonly depth: number;
}

/**
 * Builds the 16-element column-major world-to-shadow view-projection matrix for a spot light.
 * The light basis reuses the stable CSM basis so the shadow texel layout is deterministic for a
 * given direction. Points at distance `near` project to normalized depth 0 and points at `far`
 * to depth 1 (standard WebGPU depth), matching the directional receiver WGSL contract.
 */
export function buildSpotShadowViewProjection(input: SpotShadowProjectionInput): readonly number[] {
  validateSpotProjection(input);
  const near = input.near ?? input.range * 1e-4;
  const far = input.far ?? input.range;
  const basis = stableLightBasis(input.direction);
  const view = spotViewMatrix({ right: basis.x, up: basis.y, forward: basis.z }, input.position);
  const projection = Mat4.perspective(input.outerRadians * 2, 1, near, far, STANDARD_DEPTH);
  return Array.from(Mat4.multiply(projection, view));
}

/**
 * Projects a world-space point into a spot/cascade-style shadow map and computes the texel UV
 * and normalized depth. Returns undefined when the point is outside the shadow volume (behind
 * the near plane, beyond the far plane, or outside the [0, 1] uv square), mirroring the
 * receiver WGSL boundary rejection.
 */
export function projectPointToShadowSpace(
  viewProjection: ArrayLike<number>,
  worldPosition: Vec3
): ShadowSpaceSample | undefined {
  if (viewProjection.length !== 16) {
    throw new Error('Shadow view-projection must contain sixteen finite values.');
  }
  for (let index = 0; index < 16; index++) {
    if (!Number.isFinite(viewProjection[index])) {
      throw new Error('Shadow view-projection must contain sixteen finite values.');
    }
  }
  if (!vec3Finite(worldPosition)) {
    throw new Error('Shadow world position must contain three finite values.');
  }
  const clip = Mat4.transformPointHomogeneous(viewProjection, [
    worldPosition[0],
    worldPosition[1],
    worldPosition[2],
    1
  ]);
  if (Math.abs(clip[3]) <= 1e-12) return undefined;
  const inverseW = 1 / clip[3];
  const ndcX = clip[0] * inverseW;
  const ndcY = clip[1] * inverseW;
  const depth = clip[2] * inverseW;
  if (depth < 0 || depth > 1) return undefined;
  const u = ndcX * 0.5 + 0.5;
  const v = -ndcY * 0.5 + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
  const uv: [number, number] = [u, v];
  return Object.freeze({ uv: Object.freeze(uv), depth });
}

export interface DepthMapPcfInput {
  readonly uv: Readonly<[number, number]>;
  readonly depth: number;
  readonly depthMap: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly constantBias: number;
  readonly slopeBias: number;
  readonly normalDotLight: number;
  readonly tapCount?: 1 | 9;
}

/**
 * CPU oracle for 1- or 3x3-tap percentage-closer depth sampling over a packed shadow depth map
 * (row-major, one depth per texel). Applies the same bias formula and less-equal comparison as
 * the receiver WGSL.
 */
export function sampleShadowDepthMapPcf(input: DepthMapPcfInput): number {
  if (
    !Number.isSafeInteger(input.width) ||
    input.width <= 0 ||
    !Number.isSafeInteger(input.height) ||
    input.height <= 0
  ) {
    throw new Error('Shadow depth map dimensions must be positive integers.');
  }
  if (input.depthMap.length !== input.width * input.height) {
    throw new Error('Shadow depth map size must match width times height.');
  }
  if (input.uv.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) {
    throw new Error('Shadow sample UV must be within the [0, 1] square.');
  }
  const bias = computeShadowDepthBias(input.normalDotLight, input.constantBias, input.slopeBias);
  const receiverDepth = input.depth - bias;
  const centerU = Math.min(input.width - 1, Math.max(0, Math.floor(input.uv[0] * input.width)));
  const centerV = Math.min(input.height - 1, Math.max(0, Math.floor(input.uv[1] * input.height)));
  const samples: number[] = [];
  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      if (input.tapCount === 1 && (offsetX !== 0 || offsetY !== 0)) continue;
      const u = Math.max(0, Math.min(input.width - 1, centerU + offsetX));
      const v = Math.max(0, Math.min(input.height - 1, centerV + offsetY));
      samples.push(input.depthMap[v * input.width + u]!);
    }
  }
  return visibilityFromDepthSamples(receiverDepth, samples);
}

/**
 * Maps a normalized direction to a cube-map face index (`0`=+X, `1`=-X, `2`=+Y, `3`=-Y,
 * `4`=+Z, `5`=-Z) and the corresponding `[u, v]` in the [0, 1] face square using the standard
 * OpenGL cubemap convention. CPU oracle for point-light face selection.
 */
export function pointShadowFaceIndexAndUv(direction: Vec3): {
  readonly face: number;
  readonly uv: Readonly<[number, number]>;
} {
  if (!vec3Finite(direction) || Vec3Math.length(direction) <= 1e-12) {
    throw new Error('Point shadow direction must be a non-zero finite vector.');
  }
  const nx = Math.abs(direction[0]);
  const ny = Math.abs(direction[1]);
  const nz = Math.abs(direction[2]);
  let face = 0;
  let sc = -direction[2];
  let tc = -direction[1];
  let major = direction[0];
  if (ny >= nx && ny >= nz) {
    face = direction[1] >= 0 ? 2 : 3;
    sc = direction[0];
    tc = direction[1] >= 0 ? direction[2] : -direction[2];
    major = direction[1];
  } else if (nz >= nx && nz >= ny) {
    face = direction[2] >= 0 ? 4 : 5;
    sc = direction[0];
    tc = -direction[1];
    major = direction[2];
  } else if (direction[0] < 0) {
    face = 1;
    sc = direction[2];
  }
  const majorAbs = Math.abs(major);
  const uv: [number, number] = [(sc / majorAbs + 1) * 0.5, (tc / majorAbs + 1) * 0.5];
  return Object.freeze({
    face,
    uv: Object.freeze(uv)
  });
}

export interface PointShadowFaceProjectionInput {
  readonly position: Vec3;
  readonly face: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Builds the world-to-shadow view-projection matrix for one face of a point (= cube-map)
 * shadow, using a 90-degree perspective matching the cube face. `face` follows the same
 * enumeration as `pointShadowFaceIndexAndUv`.
 */
export function buildPointShadowFaceViewProjection(
  input: PointShadowFaceProjectionInput
): readonly number[] {
  if (!Number.isInteger(input.face) || input.face < 0 || input.face > 5) {
    throw new Error('Point shadow face must be an integer in [0, 5].');
  }
  if (!vec3Finite(input.position)) {
    throw new Error('Point shadow face position must be finite.');
  }
  if (!Number.isFinite(input.near) || input.near <= 0) {
    throw new Error('Point shadow face near must be positive and finite.');
  }
  if (!Number.isFinite(input.far) || input.far <= input.near) {
    throw new Error('Point shadow face far must be finite and greater than near.');
  }
  const frame = POINT_SHADOW_FACE_FRAMES[input.face]!;
  const view = spotViewMatrix(frame, input.position);
  const projection = Mat4.perspective(Math.PI / 2, 1, input.near, input.far, STANDARD_DEPTH);
  return Array.from(Mat4.multiply(projection, view));
}

/**
 * Column-major world-to-view matrix with rows `(right, up, forward)` and forward flipped to
 * the WebGPU convention (a point along `forward` maps to negative view Z).
 */
function spotViewMatrix(
  basis: Readonly<{ readonly right: Vec3; readonly up: Vec3; readonly forward: Vec3 }>,
  position: Vec3
): Float32Array {
  const row = {
    right: basis.right,
    up: basis.up,
    forwardNeg: [-basis.forward[0], -basis.forward[1], -basis.forward[2]] as Vec3
  };
  const matrix = new Float32Array(16);
  matrix[0] = row.right[0];
  matrix[1] = row.up[0];
  matrix[2] = row.forwardNeg[0];
  matrix[3] = 0;
  matrix[4] = row.right[1];
  matrix[5] = row.up[1];
  matrix[6] = row.forwardNeg[1];
  matrix[7] = 0;
  matrix[8] = row.right[2];
  matrix[9] = row.up[2];
  matrix[10] = row.forwardNeg[2];
  matrix[11] = 0;
  matrix[12] = -vecDot(row.right, position);
  matrix[13] = -vecDot(row.up, position);
  matrix[14] = vecDot(basis.forward, position);
  matrix[15] = 1;
  return matrix;
}

const POINT_SHADOW_FACE_FRAMES: Readonly<Readonly<{ right: Vec3; up: Vec3; forward: Vec3 }>>[] = [
  { right: [0, 0, -1], up: [0, -1, 0], forward: [1, 0, 0] },
  { right: [0, 0, 1], up: [0, -1, 0], forward: [-1, 0, 0] },
  { right: [1, 0, 0], up: [0, 0, 1], forward: [0, 1, 0] },
  { right: [1, 0, 0], up: [0, 0, -1], forward: [0, -1, 0] },
  { right: [1, 0, 0], up: [0, -1, 0], forward: [0, 0, 1] },
  { right: [-1, 0, 0], up: [0, -1, 0], forward: [0, 0, -1] }
];

function validateSpotProjection(input: SpotShadowProjectionInput): void {
  if (!vec3Finite(input.position)) {
    throw new Error('Spot shadow position must be finite.');
  }
  if (!vec3Finite(input.direction) || Vec3Math.length(input.direction) <= 1e-12) {
    throw new Error('Spot shadow direction must be a non-zero finite vector.');
  }
  if (!Number.isFinite(input.range) || input.range <= 0) {
    throw new Error('Spot shadow range must be positive and finite.');
  }
  if (
    !Number.isFinite(input.outerRadians) ||
    input.outerRadians <= 0 ||
    input.outerRadians >= Math.PI / 2
  ) {
    throw new Error('Spot shadow outer angle must satisfy 0 < outer < PI/2.');
  }
  const near = input.near ?? input.range * 1e-4;
  const far = input.far ?? input.range;
  if (!Number.isFinite(near) || near <= 0) {
    throw new Error('Spot shadow near must be positive and finite.');
  }
  if (!Number.isFinite(far) || far <= near) {
    throw new Error('Spot shadow far must be finite and greater than near.');
  }
}

function vecDot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function vec3Finite(value: Vec3): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}

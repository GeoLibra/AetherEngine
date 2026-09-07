/**
 * @file Deterministic CPU mathematical oracle for skybox camera rays and spherical area averages.
 */

import { Mat4, Vec3Math, type Vec3 } from '../../src/math';
import type { DirectionVec3 } from '../../tools/asset-cook/environment/convolution/coordinates';
import type { BenchmarkCameraFixture, BenchmarkViewport } from './fixtures';

/**
 * Calculates view direction for a fragment at (x, y) in viewport pixels using full inverse projection.
 */
export function perFragmentCameraRayOracle(
  fixture: BenchmarkCameraFixture,
  viewport: BenchmarkViewport,
  pixelX: number,
  pixelY: number
): DirectionVec3 {
  if (fixture.projection.kind === 'orthographic') {
    // Orthographic: all rays are parallel in direction (0, 0, -1) transformed by camera rotation
    const rot = extractRotationMatrix(fixture.viewMatrix);
    const invRot = Mat4.invert(rot);
    const dir: Vec3 = [0, 0, -1];
    const worldDir = Vec3Math.normalize(Mat4.transformDirection(invRot, dir));
    return { x: worldDir[0], y: worldDir[1], z: worldDir[2] };
  }

  // Perspective:
  // Convert physical pixel to NDC: u in [0, 1], v in [0, 1]
  const u = (pixelX + 0.5) / viewport.width;
  const v = (pixelY + 0.5) / viewport.height;
  const clipX = 2 * u - 1;
  const clipY = 1 - 2 * v;
  const zNear = fixture.depthMode === 'reverse' ? 1.0 : 0.0;

  // Unproject near plane using inverse projection
  const invProj = Mat4.invert(fixture.projectionMatrix);

  const nearPoint = new Float32Array([clipX, clipY, zNear, 1.0]);
  const viewRay = new Float32Array(4);
  transformVec4(viewRay, nearPoint, invProj);
  const w = viewRay[3];
  if (w !== undefined && w !== 0) {
    viewRay[0] = (viewRay[0] ?? 0) / w;
    viewRay[1] = (viewRay[1] ?? 0) / w;
    viewRay[2] = (viewRay[2] ?? 0) / w;
  }

  // Transform view direction by camera rotation (w = 0)
  const rot = extractRotationMatrix(fixture.viewMatrix);
  const invRot = Mat4.invert(rot);

  const worldRay = Vec3Math.normalize(
    Mat4.transformDirection(invRot, [viewRay[0]!, viewRay[1]!, viewRay[2]!])
  );

  return { x: worldRay[0], y: worldRay[1], z: worldRay[2] };
}

/**
 * Computes unnormalized near-plane ray at the 3 fullscreen vertices.
 */
export function computeFullscreenVertexRays(
  fixture: BenchmarkCameraFixture
): [DirectionVec3, DirectionVec3, DirectionVec3] {
  if (fixture.projection.kind === 'orthographic') {
    const rot = extractRotationMatrix(fixture.viewMatrix);
    const invRot = Mat4.invert(rot);
    const dir: Vec3 = [0, 0, -1];
    const worldDir = Vec3Math.normalize(Mat4.transformDirection(invRot, dir));
    const orthRay = { x: worldDir[0], y: worldDir[1], z: worldDir[2] };
    return [orthRay, orthRay, orthRay];
  }

  const invProj = Mat4.invert(fixture.projectionMatrix);
  const rot = extractRotationMatrix(fixture.viewMatrix);
  const invRot = Mat4.invert(rot);

  const zNear = fixture.depthMode === 'reverse' ? 1.0 : 0.0;
  const clipCoords: [number, number][] = [
    [-1, -1],
    [3, -1],
    [-1, 3]
  ];

  const resultRays: DirectionVec3[] = [];
  for (const [cx, cy] of clipCoords) {
    const p = new Float32Array([cx, cy, zNear, 1.0]);
    const viewRay = new Float32Array(4);
    transformVec4(viewRay, p, invProj);
    const w = viewRay[3]!;
    const unnormalizedView: Vec3 = [viewRay[0]! / w, viewRay[1]! / w, viewRay[2]! / w];
    const worldRay = Mat4.transformDirection(invRot, unnormalizedView);
    resultRays.push({ x: worldRay[0], y: worldRay[1], z: worldRay[2] });
  }

  return [resultRays[0]!, resultRays[1]!, resultRays[2]!];
}

/**
 * Emulates vertex-stage direction interpolation across fullscreen triangle at pixel (pixelX, pixelY).
 */
export function vertexInterpolatedCameraRayOracle(
  vertexRays: readonly [DirectionVec3, DirectionVec3, DirectionVec3],
  viewport: BenchmarkViewport,
  pixelX: number,
  pixelY: number
): DirectionVec3 {
  const u = (pixelX + 0.5) / viewport.width;
  const v = (pixelY + 0.5) / viewport.height;

  const r0 = vertexRays[0];
  const r1 = vertexRays[1];
  const r2 = vertexRays[2];

  const dx1 = (r1.x - r0.x) * 0.5;
  const dy1 = (r1.y - r0.y) * 0.5;
  const dz1 = (r1.z - r0.z) * 0.5;

  const dx2 = (r2.x - r0.x) * 0.5;
  const dy2 = (r2.y - r0.y) * 0.5;
  const dz2 = (r2.z - r0.z) * 0.5;

  const interpX = r0.x + dx1 * u + dx2 * (1 - v);
  const interpY = r0.y + dy1 * u + dy2 * (1 - v);
  const interpZ = r0.z + dz1 * u + dz2 * (1 - v);

  const len = Math.hypot(interpX, interpY, interpZ);
  return { x: interpX / len, y: interpY / len, z: interpZ / len };
}

/**
 * Computes angular error between two direction vectors in radians.
 */
export function computeAngularError(d1: DirectionVec3, d2: DirectionVec3): number {
  const dot = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
  return Math.acos(Math.max(-1.0, Math.min(1.0, dot)));
}

function extractRotationMatrix(view: Float32Array): Float32Array {
  const rot = new Float32Array(16);
  rot[0] = view[0]!;
  rot[1] = view[1]!;
  rot[2] = view[2]!;
  rot[4] = view[4]!;
  rot[5] = view[5]!;
  rot[6] = view[6]!;
  rot[8] = view[8]!;
  rot[9] = view[9]!;
  rot[10] = view[10]!;
  rot[15] = 1.0;
  return rot;
}

function transformVec4(out: Float32Array, v: Float32Array, m: Float32Array): void {
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  const w = v[3]!;
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w;
  out[3] = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w;
}

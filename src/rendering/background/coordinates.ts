/**
 * @file Pure mathematical coordinate transforms and direction reconstruction for Skybox / HDR Background.
 * Conforms to engine/design/v2/04-rendering/10-skybox-background.md.
 */

import { Mat4, Quat, Vec3Math, type Quaternion, type Vec3 } from '../../math';

export interface FullscreenVertexRays {
  readonly ray0: Vec3;
  readonly ray1: Vec3;
  readonly ray2: Vec3;
}

/**
 * Maps a unit 3D direction vector to canonical equirectangular UV coordinates.
 * Convention: u = fract(atan2(z, x) / (2*pi) + 0.5), v = acos(clamp(y, -1, 1)) / pi.
 */
export function directionToEquirectUv(dir: Vec3): { u: number; v: number } {
  const x = dir[0];
  const y = dir[1];
  const z = dir[2];
  let u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
  u = u - Math.floor(u);
  const v = Math.acos(Math.max(-1.0, Math.min(1.0, y))) / Math.PI;
  return { u, v };
}

/**
 * Extracts pure camera rotation matrix (w=0, no translation or scale).
 */
export function extractCameraRotationMatrix(view: ArrayLike<number>): Float32Array {
  // Extract 3x3 orthonormal rotation and transpose it to get view-to-world rotation
  const r00 = view[0]!;
  const r01 = view[1]!;
  const r02 = view[2]!;

  const r10 = view[4]!;
  const r11 = view[5]!;
  const r12 = view[6]!;

  const r20 = view[8]!;
  const r21 = view[9]!;
  const r22 = view[10]!;

  // Transpose represents inverse rotation for orthonormal matrix
  return new Float32Array([r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, 0, 0, 0, 1]);
}

/**
 * Computes unnormalized near-plane rays at the 3 fullscreen vertices for conventional perspective or orthographic.
 * Vertices in clip space: (-1, -1), (3, -1), (-1, 3) with w=1.
 */
export function computeFullscreenVertexDirections(options: {
  viewMatrix: ArrayLike<number>;
  projectionMatrix: ArrayLike<number>;
  projectionKind: 'perspective' | 'orthographic';
  depthMode: 'standard' | 'reverse';
  environmentRotation?: Quaternion | undefined;
}): FullscreenVertexRays {
  const { viewMatrix, projectionMatrix, projectionKind, depthMode, environmentRotation } = options;
  const viewToWorldRot = extractCameraRotationMatrix(viewMatrix);

  // If environment rotation is provided, sample applies its inverse: R_env^-1 * R_cam
  let finalRot = viewToWorldRot;
  if (environmentRotation !== undefined) {
    const invEnv = Quat.invert(environmentRotation);
    const envMat = Mat4.fromTRS([0, 0, 0], invEnv, [1, 1, 1]);
    finalRot = Mat4.multiply(envMat, viewToWorldRot);
  }

  if (projectionKind === 'orthographic') {
    // Orthographic: all rays are parallel in direction (0, 0, -1) transformed by rotation
    const dir = Vec3Math.normalize(Mat4.transformDirection(finalRot, [0, 0, -1]));
    return Object.freeze({
      ray0: dir,
      ray1: dir,
      ray2: dir
    });
  }

  // Perspective:
  const invProj = Mat4.invert(projectionMatrix);
  const zNear = depthMode === 'reverse' ? 1.0 : 0.0;
  const clipVertices: readonly [number, number][] = [
    [-1, -1],
    [3, -1],
    [-1, 3]
  ];

  const unnormalizedRays: Vec3[] = [];
  for (const [cx, cy] of clipVertices) {
    const p = new Float32Array([cx, cy, zNear, 1.0]);
    const viewRay = Mat4.transformPointHomogeneous(invProj, [p[0]!, p[1]!, p[2]!, p[3]!]);
    const w = viewRay[3];
    // Homogeneous divide by w at near plane
    const unnormalizedView: Vec3 = [viewRay[0] / w, viewRay[1] / w, viewRay[2] / w];
    // Transform by camera & environment rotation
    const worldRay = Mat4.transformDirection(finalRot, unnormalizedView);
    // Invariant: Do NOT normalize vertex directions before interpolation!
    unnormalizedRays.push(Object.freeze([worldRay[0], worldRay[1], worldRay[2]]) as Vec3);
  }

  return Object.freeze({
    ray0: unnormalizedRays[0]!,
    ray1: unnormalizedRays[1]!,
    ray2: unnormalizedRays[2]!
  });
}

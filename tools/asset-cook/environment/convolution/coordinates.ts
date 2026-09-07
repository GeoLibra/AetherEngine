/**
 * @file Coordinate systems, orthonormal frames, and sampling transforms for IBL convolution.
 * Adheres to sampling ABI identity 'ibl-equirect-ggx@1':
 * - Right-handed, +Y up, -Z forward.
 * - u = fract(atan2(d.z, d.x) / (2*pi) + 0.5)
 * - v = acos(clamp(d.y, -1, 1)) / pi
 * - Texel centers at (x + 0.5) / W, (y + 0.5) / H
 */

export interface DirectionVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TangentBasis {
  readonly tangent: DirectionVec3;
  readonly bitangent: DirectionVec3;
}

/**
 * Van der Corput radical inverse base 2 sequence.
 */
export function radicalInverseBase2(bits: number): number {
  let b = (bits << 16) | (bits >>> 16);
  b = ((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1);
  b = ((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2);
  b = ((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4);
  b = ((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8);
  return (b >>> 0) / 4294967296.0;
}

/**
 * Low-discrepancy 2D Hammersley point set.
 */
export function hammersley2D(i: number, n: number): [number, number] {
  return [i / n, radicalInverseBase2(i)];
}

/**
 * Maps a direction vector to equirectangular UV coordinates.
 */
export function directionToEquirectUv(d: DirectionVec3): { u: number; v: number } {
  const len = Math.hypot(d.x, d.y, d.z);
  const x = len > 1e-9 ? d.x / len : 0;
  const y = len > 1e-9 ? d.y / len : 0;
  const z = len > 1e-9 ? d.z / len : 0;

  let u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
  u = u - Math.floor(u);
  const v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI;
  return { u, v };
}

/**
 * Maps equirectangular UV coordinates to a 3D unit direction vector.
 */
export function equirectUvToDirection(u: number, v: number): DirectionVec3 {
  const phi = 2 * Math.PI * (u - 0.5);
  const theta = Math.PI * Math.max(0, Math.min(1, v));
  const sinTheta = Math.sin(theta);
  return {
    x: sinTheta * Math.cos(phi),
    y: Math.cos(theta),
    z: sinTheta * Math.sin(phi)
  };
}

/**
 * Constructs a deterministic orthonormal tangent basis around normal n.
 */
export function createTangentBasis(n: DirectionVec3): TangentBasis {
  const helper = Math.abs(n.y) < 0.999 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const tx = helper.y * n.z - helper.z * n.y;
  const ty = helper.z * n.x - helper.x * n.z;
  const tz = helper.x * n.y - helper.y * n.x;
  const tLen = Math.hypot(tx, ty, tz);
  const tangent = { x: tx / tLen, y: ty / tLen, z: tz / tLen };

  const bitangent = {
    x: n.y * tangent.z - n.z * tangent.y,
    y: n.z * tangent.x - n.x * tangent.z,
    z: n.x * tangent.y - n.y * tangent.x
  };
  return { tangent, bitangent };
}

/**
 * Bilinear sampling of equirectangular Float32 HDR buffer.
 * Invariant: Periodic wrapping on U, edge clamping on V.
 */
export function sampleEquirectBilinear(
  data: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number
): [number, number, number] {
  const wrappedU = u - Math.floor(u);
  const clampedV = Math.max(0, Math.min(1, v));

  const px = wrappedU * width - 0.5;
  const py = clampedV * height - 0.5;

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const fx = px - x0;
  const fy = py - y0;

  const getPixel = (x: number, y: number): [number, number, number] => {
    const wx = ((x % width) + width) % width;
    const wy = Math.max(0, Math.min(height - 1, y));
    const offset = (wy * width + wx) * 3;
    return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  };

  const p00 = getPixel(x0, y0);
  const p10 = getPixel(x1, y0);
  const p01 = getPixel(x0, y1);
  const p11 = getPixel(x1, y1);

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  return [
    p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11,
    p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11,
    p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11
  ];
}

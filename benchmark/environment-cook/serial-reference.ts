/**
 * @file Unoptimized serial reference implementation of environment IBL convolution.
 * Serves as the raw baseline comparator for performance benchmarks and structural tests.
 */

import type { Float32HdrImage } from './fixtures';
import { createHdrBuffer } from './fixtures';
import { directionFromEquirectUv, equirectUvFromDirection, smithG, type Vec3 } from './oracle';

/**
 * Radical inverse base 2 (Van der Corput sequence).
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
 * 2D Hammersley point set on [0, 1)^2.
 */
export function hammersley2D(i: number, n: number): [number, number] {
  return [i / n, radicalInverseBase2(i)];
}

/**
 * Deterministic orthonormal tangent frame around normal n.
 */
export function createTangentBasis(n: Vec3): { tangent: Vec3; bitangent: Vec3 } {
  const helper = Math.abs(n.y) < 0.999 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  // cross(helper, n)
  const tx = helper.y * n.z - helper.z * n.y;
  const ty = helper.z * n.x - helper.x * n.z;
  const tz = helper.x * n.y - helper.y * n.x;
  const tLen = Math.hypot(tx, ty, tz);
  const tangent = { x: tx / tLen, y: ty / tLen, z: tz / tLen };
  // cross(n, tangent)
  const bitangent = {
    x: n.y * tangent.z - n.z * tangent.y,
    y: n.z * tangent.x - n.x * tangent.z,
    z: n.x * tangent.y - n.y * tangent.x
  };
  return { tangent, bitangent };
}

/**
 * Bilinear sampling of equirectangular Float32 HDR buffer with repeat U and clamp V.
 */
export function sampleEquirectBilinear(
  image: Float32HdrImage,
  u: number,
  v: number
): [number, number, number] {
  const { width, height, data } = image;
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

/**
 * Serial unoptimized diffuse irradiance convolution.
 * Stores E(n) = pi * mean(L(w)), using cosine-weighted hemisphere sampling.
 */
export function serialReferenceIrradiance(
  source: Float32HdrImage,
  outWidth: number,
  outHeight: number,
  samples = 256
): Float32HdrImage {
  const output = createHdrBuffer(outWidth, outHeight);

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const normal = directionFromEquirectUv(u, v);
      const { tangent, bitangent } = createTangentBasis(normal);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let i = 0; i < samples; i++) {
        const [xiX, xiY] = hammersley2D(i, samples);
        const r = Math.sqrt(xiY);
        const phi = 2 * Math.PI * xiX;
        const lx = r * Math.cos(phi);
        const ly = r * Math.sin(phi);
        const lz = Math.sqrt(Math.max(0, 1 - xiY));

        const dir: Vec3 = {
          x: tangent.x * lx + bitangent.x * ly + normal.x * lz,
          y: tangent.y * lx + bitangent.y * ly + normal.y * lz,
          z: tangent.z * lx + bitangent.z * ly + normal.z * lz
        };

        const { u: sampleU, v: sampleV } = equirectUvFromDirection(dir);
        const [colR, colG, colB] = sampleEquirectBilinear(source, sampleU, sampleV);
        sumR += colR;
        sumG += colG;
        sumB += colB;
      }

      // E = pi * (sum / N)
      const factor = Math.PI / samples;
      const offset = (y * outWidth + x) * 3;
      output.data[offset] = sumR * factor;
      output.data[offset + 1] = sumG * factor;
      output.data[offset + 2] = sumB * factor;
    }
  }

  return output;
}

/**
 * Serial unoptimized GGX prefiltered radiance convolution for one roughness level.
 */
export function serialReferenceGgxRadiance(
  source: Float32HdrImage,
  outWidth: number,
  outHeight: number,
  roughness: number,
  samples = 256
): Float32HdrImage {
  const output = createHdrBuffer(outWidth, outHeight);
  const clampedRoughness = Math.max(0.001, Math.min(1.0, roughness));
  const alpha = clampedRoughness * clampedRoughness;
  const alpha2 = alpha * alpha;

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const normal = directionFromEquirectUv(u, v);
      const view = normal; // V = N = R
      const { tangent, bitangent } = createTangentBasis(normal);

      let totalWeight = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let i = 0; i < samples; i++) {
        const [xiX, xiY] = hammersley2D(i, samples);
        const phi = 2 * Math.PI * xiX;
        const cosTheta = Math.sqrt((1 - xiY) / (1 + (alpha2 - 1) * xiY));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

        const hx = sinTheta * Math.cos(phi);
        const hy = sinTheta * Math.sin(phi);
        const hz = cosTheta;

        const halfVec: Vec3 = {
          x: tangent.x * hx + bitangent.x * hy + normal.x * hz,
          y: tangent.y * hx + bitangent.y * hy + normal.y * hz,
          z: tangent.z * hx + bitangent.z * hy + normal.z * hz
        };

        const vDotH = view.x * halfVec.x + view.y * halfVec.y + view.z * halfVec.z;
        const light: Vec3 = {
          x: 2 * vDotH * halfVec.x - view.x,
          y: 2 * vDotH * halfVec.y - view.y,
          z: 2 * vDotH * halfVec.z - view.z
        };

        const nDotL = normal.x * light.x + normal.y * light.y + normal.z * light.z;
        if (nDotL > 0) {
          const { u: sampleU, v: sampleV } = equirectUvFromDirection(light);
          const [cR, cG, cB] = sampleEquirectBilinear(source, sampleU, sampleV);
          sumR += cR * nDotL;
          sumG += cG * nDotL;
          sumB += cB * nDotL;
          totalWeight += nDotL;
        }
      }

      const offset = (y * outWidth + x) * 3;
      if (totalWeight > 0) {
        output.data[offset] = sumR / totalWeight;
        output.data[offset + 1] = sumG / totalWeight;
        output.data[offset + 2] = sumB / totalWeight;
      } else {
        const [cR, cG, cB] = sampleEquirectBilinear(source, u, v);
        output.data[offset] = cR;
        output.data[offset + 1] = cG;
        output.data[offset + 2] = cB;
      }
    }
  }

  return output;
}

/**
 * Serial unoptimized BRDF LUT calculation using Hammersley sampling.
 */
export function serialReferenceBrdfLut(size: number, samples = 256): Float32Array {
  const result = new Float32Array(size * size * 2); // R: scale, G: bias

  for (let y = 0; y < size; y++) {
    const roughness = (y + 0.5) / size;
    const alpha = roughness * roughness;
    const alpha2 = alpha * alpha;

    for (let x = 0; x < size; x++) {
      const nDotV = (x + 0.5) / size;
      const sinV = Math.sqrt(Math.max(0, 1 - nDotV * nDotV));
      const vx = sinV;
      const vy = 0;
      const vz = nDotV;

      let a = 0;
      let b = 0;

      for (let i = 0; i < samples; i++) {
        const [xiX, xiY] = hammersley2D(i, samples);
        const phi = 2 * Math.PI * xiX;
        const cosTheta = Math.sqrt((1 - xiY) / (1 + (alpha2 - 1) * xiY));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

        const hx = sinTheta * Math.cos(phi);
        const hy = sinTheta * Math.sin(phi);
        const hz = cosTheta;

        const vDotH = Math.max(0, vx * hx + vy * hy + vz * hz);
        const lx = 2 * vDotH * hx - vx;
        const ly = 2 * vDotH * hy - vy;
        const lz = 2 * vDotH * hz - vz;

        const nDotL = Math.max(0, lz);
        const nDotH = Math.max(0, hz);

        if (nDotL > 0 && nDotV > 0 && nDotH > 0) {
          const g = smithG(nDotV, nDotL, alpha);
          const gVis = (g * vDotH) / (nDotH * nDotV);
          const fc = Math.pow(1 - vDotH, 5);

          a += (1 - fc) * gVis;
          b += fc * gVis;
        }
      }

      const offset = (y * size + x) * 2;
      result[offset] = a / samples;
      result[offset + 1] = b / samples;
    }
  }

  return result;
}

/**
 * @file Pure CPU GGX prefiltered radiance mip chain generator.
 * Implements truncated mip chain stopping at 16x8, level 0 spherical area resampling,
 * and isotropic GGX NDF importance sampling for levels m > 0.
 */

import {
  createTangentBasis,
  directionToEquirectUv,
  equirectUvToDirection,
  hammersley2D,
  sampleEquirectBilinear
} from './coordinates';

export interface RadianceMipLevel {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly roughness: number;
  readonly pixels: Float32Array; // Row-major RGB Float32 (3 * width * height)
}

export interface ConvolveRadianceChainOptions {
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly sampleCount?: number;
}

/**
 * Calculates number of valid levels M stopping at 16x8: M = 1 + log2(H / 8).
 */
export function calculateRadianceLevelCount(baseHeight: number): number {
  if (baseHeight < 8 || (baseHeight & (baseHeight - 1)) !== 0) {
    throw new Error(`Radiance height must be a power of two >= 8, got ${baseHeight}.`);
  }
  return 1 + Math.round(Math.log2(baseHeight / 8));
}

/**
 * Resamples source panorama into Level 0 using spherical texel footprint area weighting.
 */
export function resampleLevel0Spherical(
  sourcePixels: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number
): Float32Array {
  const outPixels = new Float32Array(outWidth * outHeight * 3);

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const [r, g, b] = sampleEquirectBilinear(sourcePixels, sourceWidth, sourceHeight, u, v);
      const offset = (y * outWidth + x) * 3;
      outPixels[offset] = r;
      outPixels[offset + 1] = g;
      outPixels[offset + 2] = b;
    }
  }

  return outPixels;
}

/**
 * Convolves one GGX prefiltered radiance mip level (roughness > 0).
 */
export function convolveGgxLevel(
  sourcePixels: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
  roughness: number,
  sampleCount: number
): Float32Array {
  const outPixels = new Float32Array(outWidth * outHeight * 3);
  const clampedRoughness = Math.max(0.001, Math.min(1.0, roughness));
  const alpha = clampedRoughness * clampedRoughness;
  const alpha2 = alpha * alpha;

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const normal = equirectUvToDirection(u, v);
      const view = normal; // V = N = R
      const { tangent, bitangent } = createTangentBasis(normal);

      let totalWeight = 0.0;
      let sumR = 0.0;
      let sumG = 0.0;
      let sumB = 0.0;

      for (let i = 0; i < sampleCount; i++) {
        const [xiX, xiY] = hammersley2D(i, sampleCount);
        const phi = 2 * Math.PI * xiX;
        const cosTheta = Math.sqrt((1 - xiY) / (1 + (alpha2 - 1) * xiY));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

        const hx = sinTheta * Math.cos(phi);
        const hy = sinTheta * Math.sin(phi);
        const hz = cosTheta;

        const halfVec = {
          x: tangent.x * hx + bitangent.x * hy + normal.x * hz,
          y: tangent.y * hx + bitangent.y * hy + normal.y * hz,
          z: tangent.z * hx + bitangent.z * hy + normal.z * hz
        };

        const vDotH = view.x * halfVec.x + view.y * halfVec.y + view.z * halfVec.z;
        const light = {
          x: 2 * vDotH * halfVec.x - view.x,
          y: 2 * vDotH * halfVec.y - view.y,
          z: 2 * vDotH * halfVec.z - view.z
        };

        const nDotL = normal.x * light.x + normal.y * light.y + normal.z * light.z;
        if (nDotL > 0) {
          const { u: sampleU, v: sampleV } = directionToEquirectUv(light);
          const [cR, cG, cB] = sampleEquirectBilinear(
            sourcePixels,
            sourceWidth,
            sourceHeight,
            sampleU,
            sampleV
          );
          sumR += cR * nDotL;
          sumG += cG * nDotL;
          sumB += cB * nDotL;
          totalWeight += nDotL;
        }
      }

      const offset = (y * outWidth + x) * 3;
      if (totalWeight > 0) {
        outPixels[offset] = sumR / totalWeight;
        outPixels[offset + 1] = sumG / totalWeight;
        outPixels[offset + 2] = sumB / totalWeight;
      } else {
        const [cR, cG, cB] = sampleEquirectBilinear(sourcePixels, sourceWidth, sourceHeight, u, v);
        outPixels[offset] = cR;
        outPixels[offset + 1] = cG;
        outPixels[offset + 2] = cB;
      }
    }
  }

  return outPixels;
}

/**
 * Convolves the complete truncated GGX prefiltered radiance mip chain.
 */
export function convolveGgxRadianceChain(
  sourcePixels: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  options: ConvolveRadianceChainOptions
): readonly RadianceMipLevel[] {
  const { baseWidth, baseHeight, sampleCount = 1024 } = options;
  const levelCount = calculateRadianceLevelCount(baseHeight);
  const maxValidLod = levelCount - 1;
  const levels: RadianceMipLevel[] = [];

  for (let level = 0; level < levelCount; level++) {
    const width = Math.max(16, baseWidth >> level);
    const height = Math.max(8, baseHeight >> level);
    const roughness = level / maxValidLod;

    const pixels =
      level === 0
        ? resampleLevel0Spherical(sourcePixels, sourceWidth, sourceHeight, width, height)
        : convolveGgxLevel(
            sourcePixels,
            sourceWidth,
            sourceHeight,
            width,
            height,
            roughness,
            sampleCount
          );

    levels.push({
      level,
      width,
      height,
      roughness,
      pixels
    });
  }

  return Object.freeze(levels);
}

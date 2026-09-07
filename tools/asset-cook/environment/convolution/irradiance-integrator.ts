/**
 * @file Pure CPU diffuse irradiance integrator.
 * Stores diffuse irradiance E(n) = integral L(w) max(dot(n,w), 0) dw = pi * mean(L(w)).
 */

import {
  createTangentBasis,
  directionToEquirectUv,
  equirectUvToDirection,
  hammersley2D,
  sampleEquirectBilinear
} from './coordinates';

export interface ConvolveIrradianceOptions {
  readonly outWidth: number;
  readonly outHeight: number;
  readonly sampleCount?: number;
}

export function convolveDiffuseIrradiance(
  sourcePixels: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  options: ConvolveIrradianceOptions
): Float32Array {
  const { outWidth, outHeight, sampleCount = 1024 } = options;
  if (outWidth <= 0 || outHeight <= 0 || outWidth !== 2 * outHeight) {
    throw new Error(`Irradiance map requires 2:1 aspect ratio, got ${outWidth}x${outHeight}.`);
  }

  const outPixels = new Float32Array(outWidth * outHeight * 3);

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const normal = equirectUvToDirection(u, v);
      const { tangent, bitangent } = createTangentBasis(normal);

      let sumR = 0.0;
      let sumG = 0.0;
      let sumB = 0.0;

      for (let i = 0; i < sampleCount; i++) {
        const [xiX, xiY] = hammersley2D(i, sampleCount);
        const r = Math.sqrt(xiY);
        const phi = 2 * Math.PI * xiX;
        const lx = r * Math.cos(phi);
        const ly = r * Math.sin(phi);
        const lz = Math.sqrt(Math.max(0, 1 - xiY));

        const dir = {
          x: tangent.x * lx + bitangent.x * ly + normal.x * lz,
          y: tangent.y * lx + bitangent.y * ly + normal.y * lz,
          z: tangent.z * lx + bitangent.z * ly + normal.z * lz
        };

        const { u: sampleU, v: sampleV } = directionToEquirectUv(dir);
        const [cR, cG, cB] = sampleEquirectBilinear(
          sourcePixels,
          sourceWidth,
          sourceHeight,
          sampleU,
          sampleV
        );
        sumR += cR;
        sumG += cG;
        sumB += cB;
      }

      // E = pi * (sum / N)
      const factor = Math.PI / sampleCount;
      const offset = (y * outWidth + x) * 3;
      outPixels[offset] = sumR * factor;
      outPixels[offset + 1] = sumG * factor;
      outPixels[offset + 2] = sumB * factor;
    }
  }

  return outPixels;
}

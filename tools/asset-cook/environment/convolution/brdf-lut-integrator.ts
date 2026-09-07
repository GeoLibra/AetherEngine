/**
 * @file Pure CPU Cook-Torrance GGX specular 2D BRDF integration table generator.
 * Produces the split-sum integration table for Fresnel scale (R) and bias (G)
 * using separable Smith GGX and Schlick Fresnel.
 */

import { hammersley2D } from './coordinates';

export function smithG1(c: number, alpha: number): number {
  if (c <= 0) return 0;
  const c2 = c * c;
  const a2 = alpha * alpha;
  return (2 * c) / (c + Math.sqrt(a2 + (1 - a2) * c2));
}

export function smithG(nDotV: number, nDotL: number, alpha: number): number {
  return smithG1(nDotV, alpha) * smithG1(nDotL, alpha);
}

export interface BrdfLutOptions {
  readonly size: number;
  readonly sampleCount?: number;
}

/**
 * Computes the 2D BRDF LUT as a 4-channel Float32 buffer [R: scale, G: bias, B: 0, A: 1].
 */
export function computeBrdfLut(options: BrdfLutOptions): Float32Array {
  const { size, sampleCount = 2048 } = options;
  if (size <= 0) {
    throw new Error(`Invalid BRDF LUT size: ${size}.`);
  }

  const out = new Float32Array(size * size * 4);

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

      let a = 0.0;
      let b = 0.0;

      for (let i = 0; i < sampleCount; i++) {
        const [xiX, xiY] = hammersley2D(i, sampleCount);
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

      const offset = (y * size + x) * 4;
      out[offset] = Math.max(0, Math.min(1, a / sampleCount));
      out[offset + 1] = Math.max(0, Math.min(1, b / sampleCount));
      out[offset + 2] = 0.0;
      out[offset + 3] = 1.0;
    }
  }

  return out;
}

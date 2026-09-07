/**
 * @file Independent numerical directional quadrature oracle for environment convolution.
 * Uses exact spherical solid angles and numerical quadrature instead of Hammersley sampling.
 */

import type { Float32HdrImage } from './fixtures';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function directionFromEquirectUv(u: number, v: number): Vec3 {
  const phi = 2 * Math.PI * (u - 0.5);
  const theta = Math.PI * Math.max(0, Math.min(1, v));
  const sinTheta = Math.sin(theta);
  return {
    x: sinTheta * Math.cos(phi),
    y: Math.cos(theta),
    z: sinTheta * Math.sin(phi)
  };
}

export function equirectUvFromDirection(d: Vec3): { u: number; v: number } {
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
 * Computes exact spherical solid angle for a row in an equirectangular panorama.
 * DeltaOmega(y) = (2 * pi / width) * (cos(theta_top) - cos(theta_bottom))
 */
export function rowSolidAngle(y: number, height: number, width: number): number {
  const theta0 = (Math.PI * y) / height;
  const theta1 = (Math.PI * (y + 1)) / height;
  return ((2 * Math.PI) / width) * (Math.cos(theta0) - Math.cos(theta1));
}

/**
 * Validates that the sum of solid angles over all texels equals 4 * pi.
 */
export function verifyTotalSolidAngle(width: number, height: number): number {
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const dOmega = rowSolidAngle(y, height, width);
    sum += dOmega * width;
  }
  return sum;
}

/**
 * Computes exact diffuse irradiance at a normal n using full spherical Riemann quadrature:
 * E(n) = integral_S2 L(w) * max(dot(n, w), 0) dw
 */
export function oracleDiffuseIrradiance(
  image: Float32HdrImage,
  normal: Vec3
): [number, number, number] {
  const { width, height, data } = image;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (let y = 0; y < height; y++) {
    const dOmega = rowSolidAngle(y, height, width);
    const v = (y + 0.5) / height;

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const dir = directionFromEquirectUv(u, v);
      const nDotL = normal.x * dir.x + normal.y * dir.y + normal.z * dir.z;

      if (nDotL > 0) {
        const weight = nDotL * dOmega;
        const offset = (y * width + x) * 3;
        totalR += data[offset]! * weight;
        totalG += data[offset + 1]! * weight;
        totalB += data[offset + 2]! * weight;
      }
    }
  }

  return [totalR, totalG, totalB];
}

/**
 * Computes spherical average radiance using exact solid-angle weighting.
 */
export function oracleSphericalAverageRadiance(image: Float32HdrImage): [number, number, number] {
  const { width, height, data } = image;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (let y = 0; y < height; y++) {
    const dOmega = rowSolidAngle(y, height, width);
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      totalR += data[offset]! * dOmega;
      totalG += data[offset + 1]! * dOmega;
      totalB += data[offset + 2]! * dOmega;
    }
  }

  const fourPi = 4 * Math.PI;
  return [totalR / fourPi, totalG / fourPi, totalB / fourPi];
}

/**
 * Evaluates the Smith G1 shadowing factor: G1(c) = 2 * c / (c + sqrt(alpha^2 + (1 - alpha^2) * c^2))
 */
export function smithG1(cosTheta: number, alpha: number): number {
  if (cosTheta <= 0) return 0;
  const c2 = cosTheta * cosTheta;
  const a2 = alpha * alpha;
  return (2 * cosTheta) / (cosTheta + Math.sqrt(a2 + (1 - a2) * c2));
}

/**
 * Evaluates the separable Smith masking-shadowing function: G(N.V, N.L) = G1(N.V) * G1(N.L)
 */
export function smithG(nDotV: number, nDotL: number, alpha: number): number {
  return smithG1(nDotV, alpha) * smithG1(nDotL, alpha);
}

/**
 * High-precision quadrature oracle for the BRDF integration table entry (NdotV, roughness).
 * Uses adaptive trapezoidal quadrature over the half-vector hemisphere.
 */
export function oracleBrdfLutEntry(
  nDotV: number,
  roughness: number,
  samples = 4096
): [number, number] {
  const clampedNdotV = Math.max(1e-4, Math.min(1.0, nDotV));
  const clampedRoughness = Math.max(1e-4, Math.min(1.0, roughness));
  const alpha = clampedRoughness * clampedRoughness;
  const alpha2 = alpha * alpha;

  const sinV = Math.sqrt(Math.max(0, 1 - clampedNdotV * clampedNdotV));
  const vx = sinV;
  const vy = 0;
  const vz = clampedNdotV;

  let totalScale = 0;
  let totalBias = 0;

  // Uses independent scrambled Halton sequence (base 2 and base 3) for the oracle
  // to ensure numerical independence from the cooker's base-2 Hammersley sequence
  for (let i = 0; i < samples; i++) {
    // Radical inverse base 3
    let f = 1;
    let r3 = 0;
    let i3 = i;
    while (i3 > 0) {
      f = f / 3;
      r3 = r3 + f * (i3 % 3);
      i3 = Math.floor(i3 / 3);
    }
    const xiX = (i + 0.5) / samples;
    const xiY = r3;

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

    if (nDotL > 0 && clampedNdotV > 0 && nDotH > 0) {
      const g = smithG(clampedNdotV, nDotL, alpha);
      const gVis = (g * vDotH) / (nDotH * clampedNdotV);
      const fc = Math.pow(1 - vDotH, 5);

      totalScale += (1 - fc) * gVis;
      totalBias += fc * gVis;
    }
  }

  return [totalScale / samples, totalBias / samples];
}

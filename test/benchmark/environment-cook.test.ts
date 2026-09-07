import { describe, expect, it } from 'vitest';
import {
  createBrightEmitterFixture,
  createConstantHdrFixture,
  createDirectionalLandmarksFixture,
  createPeriodicSeamFixture,
  createPolarCapFixture
} from '../../benchmark/environment-cook/fixtures';
import {
  directionFromEquirectUv,
  equirectUvFromDirection,
  oracleBrdfLutEntry,
  oracleDiffuseIrradiance,
  oracleSphericalAverageRadiance,
  verifyTotalSolidAngle
} from '../../benchmark/environment-cook/oracle';
import {
  sampleEquirectBilinear,
  serialReferenceBrdfLut,
  serialReferenceGgxRadiance,
  serialReferenceIrradiance
} from '../../benchmark/environment-cook/serial-reference';

describe('environment cook mathematical foundation and oracle', () => {
  it('preserves exact total spherical solid angle of 4 * pi across resolutions', () => {
    for (const [w, h] of [
      [32, 16],
      [64, 32],
      [128, 64]
    ] as const) {
      const sum = verifyTotalSolidAngle(w, h);
      expect(Math.abs(sum - 4 * Math.PI)).toBeLessThan(1e-9);
    }
  });

  it('round-trips equirectangular UVs and 3D directional vectors', () => {
    const testDirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
      { x: 0.57735, y: 0.57735, z: 0.57735 }
    ];

    for (const dir of testDirs) {
      const { u, v } = equirectUvFromDirection(dir);
      const recovered = directionFromEquirectUv(u, v);
      const len = Math.hypot(dir.x, dir.y, dir.z);
      expect(Math.abs(recovered.x - dir.x / len)).toBeLessThan(1e-5);
      expect(Math.abs(recovered.y - dir.y / len)).toBeLessThan(1e-5);
      expect(Math.abs(recovered.z - dir.z / len)).toBeLessThan(1e-5);
    }
  });

  it('proves that a constant environment C produces exactly pi * C irradiance via oracle', () => {
    const constantVal = 2.5;
    const img = createConstantHdrFixture(32, 16, [constantVal, constantVal, constantVal]);
    const expected = Math.PI * constantVal;

    const normals = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -0.7071, y: 0.7071, z: 0 }
    ];

    for (const n of normals) {
      const [r, g, b] = oracleDiffuseIrradiance(img, n);
      expect(Math.abs(r - expected) / expected).toBeLessThan(0.005);
      expect(Math.abs(g - expected) / expected).toBeLessThan(0.005);
      expect(Math.abs(b - expected) / expected).toBeLessThan(0.005);
    }

    const [avgR, avgG, avgB] = oracleSphericalAverageRadiance(img);
    expect(Math.abs(avgR - constantVal) / constantVal).toBeLessThan(1e-7);
    expect(Math.abs(avgG - constantVal) / constantVal).toBeLessThan(1e-7);
    expect(Math.abs(avgB - constantVal) / constantVal).toBeLessThan(1e-7);
  });

  it('computes diffuse irradiance matching pi * C on constant environment via serial reference', () => {
    const constantVal = 1.0;
    const img = createConstantHdrFixture(32, 16, [constantVal, constantVal, constantVal]);
    const irradiance = serialReferenceIrradiance(img, 16, 8, 256);
    const expected = Math.PI * constantVal;

    for (let i = 0; i < 16 * 8; i++) {
      const r = irradiance.data[i * 3]!;
      expect(Math.abs(r - expected) / expected).toBeLessThan(0.015);
    }
  });

  it('preserves continuity across the periodic equirectangular seam (u=0 vs u=1)', () => {
    const img = createPeriodicSeamFixture(32, 16);
    for (let y = 0; y < 16; y++) {
      const v = (y + 0.5) / 16;
      const left = sampleEquirectBilinear(img, 0.0, v);
      const right = sampleEquirectBilinear(img, 1.0, v);
      expect(Math.abs(left[0] - right[0])).toBeLessThan(1e-6);
      expect(Math.abs(left[1] - right[1])).toBeLessThan(1e-6);
      expect(Math.abs(left[2] - right[2])).toBeLessThan(1e-6);
    }
  });

  it('evaluates GGX prefiltered radiance converging to source value for constant input', () => {
    const img = createConstantHdrFixture(32, 16, [3.0, 3.0, 3.0]);
    for (const roughness of [0.1, 0.5, 0.9]) {
      const filtered = serialReferenceGgxRadiance(img, 16, 8, roughness, 128);
      for (let i = 0; i < 16 * 8; i++) {
        const val = filtered.data[i * 3]!;
        expect(Math.abs(val - 3.0) / 3.0).toBeLessThan(0.02);
      }
    }
  });

  it('validates BRDF LUT reference calculation against numerical quadrature oracle', () => {
    const lut = serialReferenceBrdfLut(16, 512);

    for (const [nDotV, roughness] of [
      [0.2, 0.3],
      [0.5, 0.5],
      [0.8, 0.7]
    ] as const) {
      const x = Math.floor(nDotV * 16);
      const y = Math.floor(roughness * 16);
      const centerNdotV = (x + 0.5) / 16;
      const centerRoughness = (y + 0.5) / 16;
      const [oracleScale, oracleBias] = oracleBrdfLutEntry(centerNdotV, centerRoughness, 2048);

      const idx = (y * 16 + x) * 2;
      const refScale = lut[idx]!;
      const refBias = lut[idx + 1]!;

      expect(Math.abs(refScale - oracleScale)).toBeLessThan(0.02);
      expect(Math.abs(refBias - oracleBias)).toBeLessThan(0.02);
    }
  });

  it('creates directional landmarks, polar cap, and bright emitter fixtures without error', () => {
    const landmarks = createDirectionalLandmarksFixture(32, 16);
    expect(landmarks.width).toBe(32);
    expect(landmarks.height).toBe(16);

    const polar = createPolarCapFixture(32, 16);
    expect(polar.width).toBe(32);

    const emitter = createBrightEmitterFixture(32, 16, 500);
    expect(emitter.width).toBe(32);
  });
});

import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../src';
import {
  ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE,
  createDefaultEnvironmentTextures,
  generateEnvironmentBrdfLutData,
  getSharedEnvironmentBrdfLut,
  getSharedEnvironmentSampler
} from '../../src/rendering/lighting/environment';

describe('environment BRDF LUT and IBL resources', () => {
  test('generates valid standard GGX BRDF LUT byte data', () => {
    const size = 16;
    const data = generateEnvironmentBrdfLutData(size, size);
    expect(data.byteLength).toBe(size * size * 4);

    // Verify channel bounds and values
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;

      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBe(0);
      expect(a).toBe(255);
    }

    // Normal incidence (N·V ~ 1) on smooth surface (roughness ~ 0): scale should be high, bias low
    // In our (x, y) mapping, x is N·V and y is roughness.
    // x = size - 1 (N·V close to 1), y = 0 (roughness close to 0)
    const normalSmoothOffset = (0 * size + (size - 1)) * 4;
    expect(data[normalSmoothOffset]!).toBeGreaterThan(150); // Scale
    expect(data[normalSmoothOffset + 1]!).toBeLessThan(50); // Bias

    // Grazing incidence (N·V ~ 0) on smooth surface: bias increases towards 1 (due to (1 - F0) * 1)
    const grazingSmoothOffset = (0 * size + 0) * 4;
    expect(data[grazingSmoothOffset + 1]!).toBeGreaterThan(100);
  });

  test('caches environment BRDF LUT per device as a singleton', () => {
    const deviceA = new NullDevice();
    const deviceB = new NullDevice();

    const lutA1 = getSharedEnvironmentBrdfLut(deviceA);
    const lutA2 = getSharedEnvironmentBrdfLut(deviceA);
    const lutB = getSharedEnvironmentBrdfLut(deviceB);

    expect(lutA1).toBe(lutA2);
    expect(lutA1).not.toBe(lutB);
    expect(lutA1.format).toBe('rgba8unorm');
    expect(lutA1.width).toBe(ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE);
    expect(lutA1.height).toBe(ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE);
  });

  test('caches environment sampler per device as a singleton', () => {
    const device = new NullDevice();
    const sampler1 = getSharedEnvironmentSampler(device);
    const sampler2 = getSharedEnvironmentSampler(device);

    expect(sampler1).toBe(sampler2);
    expect(sampler1.kind).toBe('sampler');
  });

  test('creates complete default environment texture set reusing shared BRDF LUT', () => {
    const device = new NullDevice();
    const set1 = createDefaultEnvironmentTextures(device);
    const set2 = createDefaultEnvironmentTextures(device);

    expect(set1.irradianceMap).toBeDefined();
    expect(set1.prefilteredRadianceMap).toBeDefined();
    expect(set1.environmentBrdfLut).toBeDefined();

    // The BRDF LUT should be identical shared singleton
    expect(set1.environmentBrdfLut).toBe(set2.environmentBrdfLut);
    expect(set1.environmentBrdfLut).toBe(getSharedEnvironmentBrdfLut(device));

    set1.irradianceMap.dispose();
    set1.prefilteredRadianceMap.dispose();
    set2.irradianceMap.dispose();
    set2.prefilteredRadianceMap.dispose();
  });
});

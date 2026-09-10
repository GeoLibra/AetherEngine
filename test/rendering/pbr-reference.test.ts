import { describe, expect, test } from 'vitest';

import {
  compensateMultipleScatteringIbl,
  evaluateCookTorranceDirect
} from '../../src/rendering/lighting';

describe('Cook-Torrance direct-light reference', () => {
  test('matches the hand-derived normal-incidence dielectric result', () => {
    const result = evaluateCookTorranceDirect({
      baseColorLinear: [0.8, 0.2, 0.1],
      metallic: 0,
      roughness: 0.5,
      normal: [0, 0, 1],
      viewDirection: [0, 0, 1],
      lightDirection: [0, 0, 1],
      lightRadianceLinear: [1, 1, 1]
    });

    expect(result).toEqual([
      expect.closeTo(0.295391, 5),
      expect.closeTo(0.112045, 5),
      expect.closeTo(0.081487, 5)
    ]);
  });

  test('removes the diffuse lobe for a fully metallic surface', () => {
    const result = evaluateCookTorranceDirect({
      baseColorLinear: [0.8, 0.2, 0.1],
      metallic: 1,
      roughness: 0.5,
      normal: [0, 0, 1],
      viewDirection: [0, 0, 1],
      lightDirection: [0, 0, 1],
      lightRadianceLinear: [1, 1, 1]
    });

    expect(result).toEqual([
      expect.closeTo(1.018591, 5),
      expect.closeTo(0.254648, 5),
      expect.closeTo(0.127324, 5)
    ]);
  });

  test('returns black for back-facing light and stays finite at minimum roughness', () => {
    const backFacing = evaluateCookTorranceDirect({
      baseColorLinear: [1, 1, 1],
      metallic: 0,
      roughness: 0,
      normal: [0, 0, 1],
      viewDirection: [0, 0, 1],
      lightDirection: [0, 0, -1],
      lightRadianceLinear: [1, 1, 1]
    });
    const minimumRoughness = evaluateCookTorranceDirect({
      baseColorLinear: [1, 1, 1],
      metallic: 0,
      roughness: 0,
      normal: [0, 0, 1],
      viewDirection: [0, 0, 1],
      lightDirection: [0, 0, 1],
      lightRadianceLinear: [1, 1, 1]
    });

    expect(backFacing).toEqual([0, 0, 0]);
    expect(minimumRoughness.every(Number.isFinite)).toBe(true);
  });

  test('preserves the finite GGX peak at the minimum roughness', () => {
    const result = evaluateCookTorranceDirect({
      baseColorLinear: [1, 1, 1],
      metallic: 1,
      roughness: 0,
      normal: [0, 0, 1],
      viewDirection: [0, 0, 1],
      lightDirection: [0, 0, 1],
      lightRadianceLinear: [1, 1, 1]
    });

    expect(result).toEqual([
      expect.closeTo(19_406.181142, 4),
      expect.closeTo(19_406.181142, 4),
      expect.closeTo(19_406.181142, 4)
    ]);
  });

  test('uses separable exact Smith GGX for an oblique view', () => {
    const result = evaluateCookTorranceDirect({
      baseColorLinear: [0.8, 0.2, 0.1],
      metallic: 0,
      roughness: 0.5,
      normal: [0, 0, 1],
      viewDirection: [0.6, 0, 0.8],
      lightDirection: [0, 0, 1],
      lightRadianceLinear: [1, 1, 1]
    });

    expect(result).toEqual([
      expect.closeTo(0.2545599235, 8),
      expect.closeTo(0.0712134943, 8),
      expect.closeTo(0.0406557561, 8)
    ]);
  });
});

describe('multiple-scattering IBL compensation', () => {
  test('matches the independently derived Fdez-Aguera compensation sample', () => {
    expect(
      compensateMultipleScatteringIbl({
        singleScattering: [0.2, 0.1, 0.05],
        f0: [0.8, 0.2, 0.04],
        directionalAlbedo: 0.4
      })
    ).toEqual([expect.closeTo(0.44, 12), expect.closeTo(0.13, 12), expect.closeTo(0.053, 12)]);
  });

  test('is identity at unit directional albedo and remains finite at the LUT boundary', () => {
    expect(
      compensateMultipleScatteringIbl({
        singleScattering: [0.8, 0.4, 0.2],
        f0: [1, 0.5, 0.04],
        directionalAlbedo: 1
      })
    ).toEqual([0.8, 0.4, 0.2]);
    expect(
      compensateMultipleScatteringIbl({
        singleScattering: [0, 0, 0],
        f0: [1, 1, 1],
        directionalAlbedo: 0
      }).every(Number.isFinite)
    ).toBe(true);
  });
});

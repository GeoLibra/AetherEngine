import { describe, expect, test } from 'vitest';

import { evaluateCookTorranceDirect } from '../../src/rendering/lighting';

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
});

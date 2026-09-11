import { describe, expect, test } from 'vitest';
import { evaluateStandardLitSurface } from '../../src';

describe('standard-lit surface reference', () => {
  test('composes glTF texture channels without treating data textures as colors', () => {
    const surface = evaluateStandardLitSurface({
      baseColorFactor: [0.5, 0.25, 1, 0.8],
      metallicFactor: 0.75,
      roughnessFactor: 0.5,
      emissiveFactor: [2, 1, 0.5],
      normalScale: 0.5,
      occlusionStrength: 0.25,
      samples: {
        baseColor: [0.4, 0.8, 0.25, 0.5],
        metallicRoughness: [0.1, 0.6, 0.8, 1],
        normal: [0.75, 0.25, 1, 1],
        occlusion: [0.2, 0, 0, 1],
        emissive: [0.25, 0.5, 0.8, 1]
      }
    });

    expect(surface).toEqual({
      baseColor: [0.2, 0.2, 0.25, 0.4],
      metallic: 0.6000000000000001,
      roughness: 0.3,
      tangentNormal: [0.23570226039551587, -0.23570226039551587, 0.9428090415820635],
      occlusion: 0.8,
      emissive: [0.5, 0.5, 0.4],
      covered: true
    });
  });

  test('evaluates opaque and alpha-mask coverage from the composed alpha', () => {
    const input = {
      baseColorFactor: [1, 1, 1, 0.8] as const,
      metallicFactor: 0,
      roughnessFactor: 1,
      emissiveFactor: [0, 0, 0] as const,
      normalScale: 1,
      occlusionStrength: 1,
      samples: {
        baseColor: [1, 1, 1, 0.5] as const,
        metallicRoughness: [1, 1, 1, 1] as const,
        normal: [0.5, 0.5, 1, 1] as const,
        occlusion: [1, 1, 1, 1] as const,
        emissive: [0, 0, 0, 1] as const
      }
    };

    expect(
      evaluateStandardLitSurface({ ...input, alphaMode: 'opaque', alphaCutoff: 0.9 }).covered
    ).toBe(true);
    expect(
      evaluateStandardLitSurface({ ...input, alphaMode: 'mask', alphaCutoff: 0.4 }).covered
    ).toBe(true);
    expect(
      evaluateStandardLitSurface({ ...input, alphaMode: 'mask', alphaCutoff: 0.4001 }).covered
    ).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';

import { evaluateCookTorranceDirect } from '../../src/rendering/lighting';

const PI = Math.PI;
const MIN_ROUGHNESS = 0.045;

describe('standard PBR numerical integration oracle', () => {
  test.each([0.045, 0.1, 0.5, 1])(
    'normalizes projected GGX area at perceptual roughness %s',
    (roughness) => {
      const integral = integrateProjectedDistribution(roughness, 8_000);

      expect(integral).toBeGreaterThan(0.99);
      expect(integral).toBeLessThan(1.01);
    }
  );

  test('matches independently evaluated oblique dielectric samples', () => {
    const samples = [
      {
        view: [0.6, 0, 0.8] as const,
        light: [0, 0, 1] as const,
        expected: [0.25455992346692896, 0.07121349427292917, 0.04065575607392921]
      },
      {
        view: [0, 0.8, 0.6] as const,
        light: [0.8, 0, 0.6] as const,
        expected: independentDirectSample([0, 0.8, 0.6], [0.8, 0, 0.6])
      }
    ];

    for (const sample of samples) {
      const actual = evaluateCookTorranceDirect({
        baseColorLinear: [0.8, 0.2, 0.1],
        metallic: 0,
        roughness: 0.5,
        normal: [0, 0, 1],
        viewDirection: sample.view,
        lightDirection: sample.light,
        lightRadianceLinear: [1, 1, 1]
      });

      for (let channel = 0; channel < 3; channel++) {
        const reference = sample.expected[channel]!;
        expect(Math.abs(actual[channel]! - reference)).toBeLessThanOrEqual(
          1e-5 + 2e-3 * Math.abs(reference)
        );
      }
    }
  });
});

function integrateProjectedDistribution(perceptualRoughness: number, steps: number): number {
  const roughness = Math.max(MIN_ROUGHNESS, perceptualRoughness);
  const alpha = roughness * roughness;
  const minimumLogSlope = -16;
  const maximumLogSlope = 16;
  const width = (maximumLogSlope - minimumLogSlope) / steps;
  let sum = 0;

  for (let index = 0; index < steps; index++) {
    const logSlope = minimumLogSlope + (index + 0.5) * width;
    const tangent = alpha * Math.exp(logSlope);
    const inverseLength = 1 / Math.sqrt(1 + tangent * tangent);
    const normalDotHalf = inverseLength;
    const halfDirection = [tangent * inverseLength, 0, normalDotHalf] as const;
    const geometry = smithGgx(normalDotHalf, alpha) ** 2;
    const radiance = evaluateCookTorranceDirect({
      baseColorLinear: [1, 1, 1],
      metallic: 1,
      roughness,
      normal: [0, 0, 1],
      viewDirection: halfDirection,
      lightDirection: halfDirection,
      lightRadianceLinear: [1, 1, 1]
    })[0];
    const distribution = (radiance * 4 * normalDotHalf) / geometry;
    const solidAngleJacobian = (2 * PI * tangent * tangent) / (1 + tangent * tangent) ** 2;
    sum += distribution * solidAngleJacobian * width;
  }

  return sum;
}

function independentDirectSample(
  view: readonly [number, number, number],
  light: readonly [number, number, number]
): readonly [number, number, number] {
  const baseColor = [0.8, 0.2, 0.1] as const;
  const alpha = 0.25;
  const normalDotView = view[2];
  const normalDotLight = light[2];
  const halfUnnormalized = [view[0] + light[0], view[1] + light[1], view[2] + light[2]];
  const halfLength = Math.hypot(...halfUnnormalized);
  const half = halfUnnormalized.map((component) => component / halfLength);
  const normalDotHalf = half[2]!;
  const viewDotHalf = view[0] * half[0]! + view[1] * half[1]! + view[2] * half[2]!;
  const denominator = 1 - normalDotHalf * normalDotHalf + (alpha * normalDotHalf) ** 2;
  const distribution = (alpha / denominator) ** 2 / PI;
  const geometry = smithGgx(normalDotView, alpha) * smithGgx(normalDotLight, alpha);
  const fresnel = 0.04 + 0.96 * (1 - viewDotHalf) ** 5;
  const specular = (distribution * geometry * fresnel) / (4 * normalDotView * normalDotLight);

  return baseColor.map(
    (component) => (((1 - fresnel) * component) / PI + specular) * normalDotLight
  ) as unknown as readonly [number, number, number];
}

function smithGgx(normalDotDirection: number, alpha: number): number {
  return (
    (2 * normalDotDirection) /
    (normalDotDirection +
      Math.sqrt(alpha * alpha + (1 - alpha * alpha) * normalDotDirection * normalDotDirection))
  );
}

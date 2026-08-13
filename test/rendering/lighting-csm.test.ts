import { describe, expect, test } from 'vitest';
import {
  buildStableCascade,
  computeCascadeSplits,
  snapShadowCoordinate,
  stableLightBasis
} from '../../src/rendering';

describe('stable cascaded shadows', () => {
  test('computes uniform/logarithmic mixes and clamps lambda', () => {
    expect(computeCascadeSplits(1, 100, 2, 0)).toEqual([50.5, 100]);
    expect(computeCascadeSplits(1, 100, 2, 1)).toEqual([10, 100]);
    expect(computeCascadeSplits(1, 100, 2, 2)).toEqual([10, 100]);
  });

  test('uses the documented half-positive tie rule and stable axis selection', () => {
    expect(snapShadowCoordinate(0.5, 1)).toBe(1);
    expect(snapShadowCoordinate(-0.5, 1)).toBe(0);
    expect(snapShadowCoordinate(10.011, 0.03125)).toBe(10);
    expect(snapShadowCoordinate(10.02, 0.03125)).toBe(10.03125);
    expect(snapShadowCoordinate(-10.02, 0.03125)).toBe(-10.03125);
    expect(stableLightBasis([1, 0, 0]).upAxis).toBe('y');
    expect(stableLightBasis([0.999999, 0.001, 0]).upAxis).toBe('z');
  });

  test('builds conservative square bounds and snaps only XY', () => {
    const cascade = buildStableCascade({
      cornersWorld: cubeCorners([10.011, 0, 0], 32),
      lightDirection: [0, 0, -1],
      usableResolution: 2048,
      casterDepthRange: { min: -50, max: 80 },
      radiusQuantum: 1
    });
    expect(cascade.radius).toBeGreaterThanOrEqual(cascade.rawRadius);
    expect(cascade.worldUnitsPerTexel).toBe((2 * cascade.radius) / 2048);
    expect(cascade.boundsLightSpace.right - cascade.boundsLightSpace.left).toBe(2 * cascade.radius);
    expect(cascade.boundsLightSpace).toMatchObject({ near: -50, far: 80 });
    expect(cascade.snappedCenterLightSpace[2]).toBe(cascade.centerLightSpace[2]);
  });

  test('keeps sub-texel movement stable and treats usable tile border as resolution policy', () => {
    const first = stableCascadeAt([0, 10.001, 0], 2048, { min: -10, max: 20 });
    const subTexel = stableCascadeAt([0, 10.002, 0], 2048, { min: -100, max: 200 });
    const bordered = stableCascadeAt([0, 10.001, 0], 2046, { min: -10, max: 20 });

    expect(subTexel.snappedCenterLightSpace.slice(0, 2)).toEqual(
      first.snappedCenterLightSpace.slice(0, 2)
    );
    expect(subTexel.boundsLightSpace).toMatchObject({ near: -100, far: 200 });
    expect(subTexel.boundsLightSpace.left).toBe(first.boundsLightSpace.left);
    expect(subTexel.boundsLightSpace.right).toBe(first.boundsLightSpace.right);
    expect(bordered.worldUnitsPerTexel).not.toBe(first.worldUnitsPerTexel);
  });

  test('preserves extent across a floating-origin frame-boundary translation', () => {
    const before = stableCascadeAt([0, 0, 0], 1024, { min: -10, max: 20 });
    const after = stableCascadeAt([256, -128, 64], 1024, { min: -10, max: 20 });

    expect(after.radius).toBe(before.radius);
    expect(after.radius).toBeGreaterThanOrEqual(after.rawRadius);
    expect(after.basis).toEqual(before.basis);
    expect(after.centerWorld).toEqual([256, -128, 64]);
  });
});

function cubeCorners(center: readonly [number, number, number], half: number) {
  return [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map(
        (z) => [center[0] + x * half, center[1] + y * half, center[2] + z * half] as const
      )
    )
  );
}

function stableCascadeAt(
  center: readonly [number, number, number],
  usableResolution: number,
  casterDepthRange: Readonly<{ min: number; max: number }>
) {
  return buildStableCascade({
    cornersWorld: cubeCorners(center, 32 / Math.sqrt(3)),
    lightDirection: [0, 0, -1],
    usableResolution,
    casterDepthRange,
    radiusQuantum: 1
  });
}

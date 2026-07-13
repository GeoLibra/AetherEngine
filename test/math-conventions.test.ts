import { describe, expect, test } from 'vitest';
import type { Quaternion } from '../src';
import {
  Color,
  Frustum,
  Mat4,
  Quat,
  REVERSE_DEPTH,
  degreesToRadians,
  projectPoint,
  radiansToDegrees,
  unprojectPoint
} from '../src';

describe('Foundation math conventions', () => {
  test('Mat4.multiply returns a * b for column vectors', () => {
    const translation = Mat4.fromTranslation([1, 0, 0]);
    const scale = Mat4.fromScale([2, 2, 2]);

    const translationAfterScale = Mat4.transformPoint(
      Mat4.multiply(translation, scale),
      [1, 0, 0]
    );
    const scaleAfterTranslation = Mat4.transformPoint(
      Mat4.multiply(scale, translation),
      [1, 0, 0]
    );

    expect(translationAfterScale).toEqual([3, 0, 0]);
    expect(scaleAfterTranslation).toEqual([4, 0, 0]);
  });

  test('normalizes right-handed quaternions and rejects near-zero inputs', () => {
    const rotation = Quat.fromAxisAngle([0, 1, 0], Math.PI / 2);
    const matrix = Mat4.fromTRS([0, 0, 0], rotation, [1, 1, 1]);

    expectVector(Mat4.transformDirection(matrix, [0, 0, -1]), [-1, 0, 0]);
    expect(() => Quat.normalize([0, 0, 0, 0])).toThrow('near-zero');
  });

  test('converts finite authoring angles at the degrees boundary', () => {
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI);
    expect(radiansToDegrees(Math.PI / 2)).toBeCloseTo(90);
    expect(() => degreesToRadians(Number.NaN)).toThrow('finite');
    expect(() => radiansToDegrees(Number.POSITIVE_INFINITY)).toThrow('finite');
  });

  test('constructs intrinsic YXZ rotations from known and mixed angles', () => {
    const yOnly = Quat.fromEulerYXZ([0, Math.PI / 2, 0]);
    expectQuaternionEquivalent(yOnly, Quat.fromAxisAngle([0, 1, 0], Math.PI / 2));

    const euler = [0.35, -0.7, 0.2] as const;
    const composed = Quat.multiply(
      Quat.multiply(
        Quat.fromAxisAngle([0, 1, 0], euler[1]),
        Quat.fromAxisAngle([1, 0, 0], euler[0])
      ),
      Quat.fromAxisAngle([0, 0, 1], euler[2])
    );
    expectQuaternionEquivalent(Quat.fromEulerYXZ(euler), composed);
  });

  test('canonicalizes YXZ Euler angles without changing the rotation', () => {
    for (const euler of [
      [0.35, -0.7, 0.2],
      [Math.PI / 2, 1.1, -0.6],
      [-Math.PI / 2, 0.8, 0.4]
    ] as const) {
      const rotation = Quat.fromEulerYXZ(euler);
      const canonical = Quat.toEulerYXZ(rotation);
      expect(canonical[0]).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(canonical[0]).toBeLessThanOrEqual(Math.PI / 2);
      expectQuaternionEquivalent(Quat.fromEulerYXZ(canonical), rotation);
    }
  });

  test('selects the nearest equivalent YXZ branch for authoring continuity', () => {
    for (const reference of [
      [0.2, Math.PI + 0.05, -0.3],
      [Math.PI / 2, 1.1, -0.6],
      [-Math.PI / 2, 0.8, 0.4],
      [Math.PI / 2 + 1e-6, 0.9, -0.2],
      [-Math.PI / 2 - 1e-6, -0.7, 0.35]
    ] as const) {
      const rotation = Quat.fromEulerYXZ(reference);
      const displayed = Quat.toEulerYXZ(rotation, reference);
      expectQuaternionEquivalent(Quat.fromEulerYXZ(displayed), rotation);
      expectVector(displayed, reference, 1e-5);
    }
  });

  test('treats quaternion signs as equivalent and interpolates by the shortest path', () => {
    const rotation = Quat.fromEulerYXZ([0.2, -0.7, 0.4]);
    const negated = [
      -rotation[0],
      -rotation[1],
      -rotation[2],
      -rotation[3]
    ] as const;
    expectQuaternionEquivalent(rotation, negated);
    expectQuaternionEquivalent(Quat.slerp(rotation, negated, 0.5), rotation);

    const start = Quat.fromEulerYXZ([0, 0, 0]);
    const end = Quat.fromEulerYXZ([0, (Math.PI * 3) / 2, 0]);
    const midpoint = Quat.slerp(start, end, 0.5);
    expectQuaternionEquivalent(midpoint, Quat.fromEulerYXZ([0, -Math.PI / 4, 0]));
  });

  test('rejects invalid Euler rotations and continuity references', () => {
    expect(() => Quat.fromEulerYXZ([Number.NaN, 0, 0])).toThrow('finite');
    expect(() => Quat.toEulerYXZ([0, 0, 0, 0])).toThrow('near-zero');
    expect(() =>
      Quat.toEulerYXZ(Quat.identity(), [0, Number.POSITIVE_INFINITY, 0])
    ).toThrow('finite');
  });

  test('uses WebGPU zero-to-one depth and the z >= 0 near frustum plane', () => {
    const projection = Mat4.perspective(Math.PI / 2, 1, 0.1, 100);

    expect(ndcZ(projection, -0.1)).toBeCloseTo(0, 6);
    expect(ndcZ(projection, -100)).toBeCloseTo(1, 6);

    const frustum = Frustum.fromViewProjection(projection);
    expect(frustum.containsPoint([0, 0, -1])).toBe(true);
    expect(frustum.containsPoint([0, 0, 1])).toBe(false);
    expect(frustum.containsPoint([0, 0, -101])).toBe(false);
  });

  test('makes reverse-Z an explicit projection convention', () => {
    const projection = Mat4.perspective(Math.PI / 2, 1, 1, 100, REVERSE_DEPTH);

    expect(ndcZ(projection, -1)).toBeCloseTo(1);
    expect(ndcZ(projection, -100)).toBeCloseTo(0);
    expect(REVERSE_DEPTH).toEqual({ mode: 'reverse', clear: 0, compare: 'greater' });
  });

  test('round-trips world and top-left-origin screen coordinates', () => {
    const projection = Mat4.perspective(Math.PI / 3, 16 / 9, 0.1, 100);
    const viewport = { x: 0, y: 0, width: 1920, height: 1080 };
    const point: readonly [number, number, number] = [1.5, -0.75, -8];

    const screen = projectPoint(point, projection, viewport);
    const restored = unprojectPoint(screen, Mat4.invert(projection), viewport);

    expectVector(restored, point, 1e-4);
    expect(screen[1]).toBeGreaterThan(540);
  });

  test('matches sRGB reference values and premultiplied alpha round-trips', () => {
    expect(Color.srgbChannelToLinear(0.5)).toBeCloseTo(0.21404114, 7);
    expect(Color.linearChannelToSrgb(0.21404114)).toBeCloseTo(0.5, 7);

    const premultiplied = Color.premultiply([0.8, 0.4, 0.2, 0.5]);
    expect(premultiplied).toEqual([0.4, 0.2, 0.1, 0.5]);
    expect(Color.unpremultiply(premultiplied)).toEqual([0.8, 0.4, 0.2, 0.5]);
    expect(Color.unpremultiply([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });
});

function ndcZ(matrix: Float32Array, z: number): number {
  const clip = Mat4.transformPointHomogeneous(matrix, [0, 0, z, 1]);
  return clip[2] / clip[3];
}

function expectVector(
  actual: readonly number[],
  expected: readonly number[],
  epsilon = 1e-5
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits(epsilon)));
}

function expectQuaternionEquivalent(
  actual: Quaternion,
  expected: Quaternion,
  epsilon = 1e-10
): void {
  const dot = Math.abs(
    actual[0] * expected[0] +
      actual[1] * expected[1] +
      actual[2] * expected[2] +
      actual[3] * expected[3]
  );
  expect(1 - dot).toBeLessThanOrEqual(epsilon);
}

function digits(epsilon: number): number {
  return Math.max(0, Math.floor(-Math.log10(epsilon)));
}

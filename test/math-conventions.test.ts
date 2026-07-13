import { describe, expect, test } from 'vitest';
import {
  Color,
  Frustum,
  Mat4,
  Quat,
  REVERSE_DEPTH,
  projectPoint,
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

function digits(epsilon: number): number {
  return Math.max(0, Math.floor(-Math.log10(epsilon)));
}

import { describe, expect, test } from 'vitest';
import { Vec3Math } from '../../src/math';

describe('Vec3Math', () => {
  test('constants provide frozen zero, one and unit axes', () => {
    expect(Vec3Math.zero()).toEqual([0, 0, 0]);
    expect(Vec3Math.one()).toEqual([1, 1, 1]);
    expect(Vec3Math.unitX()).toEqual([1, 0, 0]);
    expect(Vec3Math.unitY()).toEqual([0, 1, 0]);
    expect(Vec3Math.unitZ()).toEqual([0, 0, 1]);
    expect(Object.isFrozen(Vec3Math.zero())).toBe(true);
  });

  test('performs basic vector arithmetic component-wise', () => {
    const a = [1, 2, 3] as const;
    const b = [4, 5, 6] as const;

    expect(Vec3Math.add(a, b)).toEqual([5, 7, 9]);
    expect(Vec3Math.subtract(a, b)).toEqual([-3, -3, -3]);
    expect(Vec3Math.multiply(a, b)).toEqual([4, 10, 18]);
    expect(Vec3Math.scale(a, 2)).toEqual([2, 4, 6]);
  });

  test('computes dot and cross products correctly', () => {
    const x = [1, 0, 0] as const;
    const y = [0, 1, 0] as const;

    expect(Vec3Math.dot(x, y)).toBe(0);
    expect(Vec3Math.dot(x, x)).toBe(1);
    expect(Vec3Math.cross(x, y)).toEqual([0, 0, 1]);
    expect(Vec3Math.cross(y, x)).toEqual([0, 0, -1]);
  });

  test('computes lengths and distances', () => {
    const v = [3, 4, 0] as const;
    expect(Vec3Math.lengthSq(v)).toBe(25);
    expect(Vec3Math.length(v)).toBe(5);

    const from = [1, 1, 1] as const;
    const to = [4, 5, 1] as const;
    expect(Vec3Math.distanceSq(from, to)).toBe(25);
    expect(Vec3Math.distance(from, to)).toBe(5);
  });

  test('normalizes vectors and rejects near-zero or non-finite inputs', () => {
    const normalized = Vec3Math.normalize([0, 3, 4]);
    expect(normalized[0]).toBe(0);
    expect(normalized[1]).toBeCloseTo(0.6);
    expect(normalized[2]).toBeCloseTo(0.8);
    expect(Object.isFrozen(normalized)).toBe(true);

    expect(() => Vec3Math.normalize([0, 0, 0])).toThrow(/non-zero/i);
    expect(() => Vec3Math.normalize([Number.NaN, 1, 0])).toThrow(/finite/i);
  });

  test('interpolates between vectors and compares equality', () => {
    const a = [0, 0, 0] as const;
    const b = [10, 20, 30] as const;

    expect(Vec3Math.lerp(a, b, 0.5)).toEqual([5, 10, 15]);
    expect(Vec3Math.equals([1, 2, 3], [1.0000001, 2, 3], 1e-5)).toBe(true);
    expect(Vec3Math.equals([1, 2, 3], [1.1, 2, 3], 1e-5)).toBe(false);
  });
});

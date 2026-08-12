import type { Plane, Vec3 } from './types';

export type FrustumIntersection = 'outside' | 'intersecting' | 'inside';
export const ALL_FRUSTUM_PLANES = 0b11_1111;

export interface FrustumClassification {
  readonly intersection: FrustumIntersection;
  readonly planeMask: number;
  readonly planeTests: number;
}

export class Frustum {
  private constructor(readonly planes: readonly Plane[]) {}

  static fromViewProjection(matrix: ArrayLike<number>): Frustum {
    const row0 = row(matrix, 0);
    const row1 = row(matrix, 1);
    const row2 = row(matrix, 2);
    const row3 = row(matrix, 3);
    return new Frustum(
      Object.freeze([
        plane(add(row3, row0)),
        plane(subtract(row3, row0)),
        plane(add(row3, row1)),
        plane(subtract(row3, row1)),
        plane(row2),
        plane(subtract(row3, row2))
      ])
    );
  }

  containsPoint(point: Vec3): boolean {
    return this.planes.every(
      ({ normal, distance }) =>
        normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] + distance >= 0
    );
  }

  classifySphere(
    center: Vec3,
    radius: number,
    planeMask = ALL_FRUSTUM_PLANES
  ): FrustumClassification {
    if (center.some((value) => !Number.isFinite(value)) || !Number.isFinite(radius) || radius < 0)
      throw new Error('Sphere radius must be finite and non-negative.');
    let remaining = planeMask & ALL_FRUSTUM_PLANES;
    let tests = 0;
    for (let index = 0; index < this.planes.length; index++) {
      const bit = 1 << index;
      if ((remaining & bit) === 0) continue;
      tests++;
      const distance = signedDistance(this.planes[index]!, center);
      if (distance < -radius)
        return { intersection: 'outside', planeMask: remaining, planeTests: tests };
      if (distance >= radius) remaining &= ~bit;
    }
    return classification(remaining, tests);
  }

  classifyAabb(min: Vec3, max: Vec3, planeMask = ALL_FRUSTUM_PLANES): FrustumClassification {
    if (
      min.some(
        (value, index) =>
          !Number.isFinite(value) || !Number.isFinite(max[index]!) || value > max[index]!
      )
    ) {
      throw new Error('AABB min/max must be finite and ordered.');
    }
    let remaining = planeMask & ALL_FRUSTUM_PLANES;
    let tests = 0;
    for (let index = 0; index < this.planes.length; index++) {
      const bit = 1 << index;
      if ((remaining & bit) === 0) continue;
      tests++;
      const { normal, distance } = this.planes[index]!;
      const [x, y, z] = normal;
      const positiveDistance =
        x * (x >= 0 ? max[0] : min[0]) +
        y * (y >= 0 ? max[1] : min[1]) +
        z * (z >= 0 ? max[2] : min[2]) +
        distance;
      if (positiveDistance < 0)
        return { intersection: 'outside', planeMask: remaining, planeTests: tests };
      const negativeDistance =
        x * (x >= 0 ? min[0] : max[0]) +
        y * (y >= 0 ? min[1] : max[1]) +
        z * (z >= 0 ? min[2] : max[2]) +
        distance;
      if (negativeDistance >= 0) remaining &= ~bit;
    }
    return classification(remaining, tests);
  }
}

function classification(remaining: number, tests: number): FrustumClassification {
  return {
    intersection: remaining === 0 ? 'inside' : 'intersecting',
    planeMask: remaining,
    planeTests: tests
  };
}

function signedDistance(plane: Plane, point: Vec3): number {
  return (
    plane.normal[0] * point[0] +
    plane.normal[1] * point[1] +
    plane.normal[2] * point[2] +
    plane.distance
  );
}

function row(matrix: ArrayLike<number>, index: number): readonly [number, number, number, number] {
  return [matrix[index]!, matrix[4 + index]!, matrix[8 + index]!, matrix[12 + index]!];
}

function add(
  left: readonly number[],
  right: readonly number[]
): readonly [number, number, number, number] {
  return [left[0]! + right[0]!, left[1]! + right[1]!, left[2]! + right[2]!, left[3]! + right[3]!];
}

function subtract(
  left: readonly number[],
  right: readonly number[]
): readonly [number, number, number, number] {
  return [left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!, left[3]! - right[3]!];
}

function plane(value: readonly [number, number, number, number]): Plane {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length < 1e-12) {
    throw new Error('Cannot normalize a degenerate frustum plane.');
  }
  return Object.freeze({
    normal: Object.freeze([value[0] / length, value[1] / length, value[2] / length]) as Vec3,
    distance: value[3] / length
  });
}

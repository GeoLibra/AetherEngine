import type { Plane, Vec3 } from './types';

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

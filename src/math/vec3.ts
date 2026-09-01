import type { Vec3 } from './types';

/**
 * Pure, immutable 3D vector arithmetic and linear algebra operations.
 */
export const Vec3Math = Object.freeze({
  /** Returns the vector [0, 0, 0]. */
  zero(): Vec3 {
    return Object.freeze([0, 0, 0]) as Vec3;
  },

  /** Returns the vector [1, 1, 1]. */
  one(): Vec3 {
    return Object.freeze([1, 1, 1]) as Vec3;
  },

  /** Returns the unit X axis [1, 0, 0]. */
  unitX(): Vec3 {
    return Object.freeze([1, 0, 0]) as Vec3;
  },

  /** Returns the unit Y axis [0, 1, 0]. */
  unitY(): Vec3 {
    return Object.freeze([0, 1, 0]) as Vec3;
  },

  /** Returns the unit Z axis [0, 0, 1]. */
  unitZ(): Vec3 {
    return Object.freeze([0, 0, 1]) as Vec3;
  },

  /** Adds two vectors component-wise. */
  add(left: Vec3, right: Vec3): Vec3 {
    return Object.freeze([left[0] + right[0], left[1] + right[1], left[2] + right[2]]) as Vec3;
  },

  /** Subtracts `right` from `left` component-wise. */
  subtract(left: Vec3, right: Vec3): Vec3 {
    return Object.freeze([left[0] - right[0], left[1] - right[1], left[2] - right[2]]) as Vec3;
  },

  /** Multiplies two vectors component-wise (Hadamard product). */
  multiply(left: Vec3, right: Vec3): Vec3 {
    return Object.freeze([left[0] * right[0], left[1] * right[1], left[2] * right[2]]) as Vec3;
  },

  /** Scales a vector by a scalar factor. */
  scale(vector: Vec3, factor: number): Vec3 {
    return Object.freeze([vector[0] * factor, vector[1] * factor, vector[2] * factor]) as Vec3;
  },

  /** Computes the dot product of two 3D vectors. */
  dot(left: Vec3, right: Vec3): number {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  },

  /** Computes the cross product `left × right`. */
  cross(left: Vec3, right: Vec3): Vec3 {
    return Object.freeze([
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0]
    ]) as Vec3;
  },

  /** Computes the squared Euclidean length of a vector. */
  lengthSq(vector: Vec3): number {
    return vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
  },

  /** Computes the Euclidean length of a vector. */
  length(vector: Vec3): number {
    return Math.hypot(vector[0], vector[1], vector[2]);
  },

  /** Computes the squared Euclidean distance between two points. */
  distanceSq(from: Vec3, to: Vec3): number {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    return dx * dx + dy * dy + dz * dz;
  },

  /** Computes the Euclidean distance between two points. */
  distance(from: Vec3, to: Vec3): number {
    return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  },

  /**
   * Normalizes a 3D vector to unit length.
   *
   * @throws When vector components are non-finite or vector length is near zero.
   */
  normalize(vector: Vec3, name = 'Vector'): Vec3 {
    assertFiniteVec3(vector, name);
    const len = Math.hypot(vector[0], vector[1], vector[2]);
    if (len <= 1e-12) {
      throw new Error(`${name} must be non-zero.`);
    }
    return Object.freeze([vector[0] / len, vector[1] / len, vector[2] / len]) as Vec3;
  },

  /** Linearly interpolates between `from` and `to` by parameter `factor`. */
  lerp(from: Vec3, to: Vec3, factor: number): Vec3 {
    return Object.freeze([
      from[0] + (to[0] - from[0]) * factor,
      from[1] + (to[1] - from[1]) * factor,
      from[2] + (to[2] - from[2]) * factor
    ]) as Vec3;
  },

  /**
   * Compares two vectors for equality within an optional absolute tolerance.
   */
  equals(left: Vec3, right: Vec3, epsilon = 1e-6): boolean {
    return (
      Math.abs(left[0] - right[0]) <= epsilon &&
      Math.abs(left[1] - right[1]) <= epsilon &&
      Math.abs(left[2] - right[2]) <= epsilon
    );
  }
});

function assertFiniteVec3(value: Vec3, name: string): void {
  if (
    value.length !== 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2])
  ) {
    throw new Error(`${name} must contain three finite values.`);
  }
}

import type { Bounds3 } from './types';

/**
 * Creates an immutable 3D bounding box with finite bounds verification.
 *
 * @throws When coordinates are non-finite or when min exceeds max along any axis.
 */
export function createBounds3(
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): Bounds3 {
  for (let index = 0; index < 3; index += 1) {
    const minVal = min[index]!;
    const maxVal = max[index]!;
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      throw new Error(`Bounds coordinates must be finite (axis ${index}: [${minVal}, ${maxVal}]).`);
    }
    if (minVal > maxVal) {
      throw new Error(`Bounds min cannot exceed max along axis ${index} (${minVal} > ${maxVal}).`);
    }
  }
  return Object.freeze({
    min: Object.freeze([min[0]!, min[1]!, min[2]!]) as readonly [number, number, number],
    max: Object.freeze([max[0]!, max[1]!, max[2]!]) as readonly [number, number, number]
  });
}

/**
 * Computes exact Bounds3 from a Float32Array or typed float position buffer.
 */
export function computePositionBounds3(
  positions: Float32Array | ArrayLike<number>,
  vertexCount: number,
  stride = 3,
  offset = 0
): Bounds3 {
  if (vertexCount === 0) {
    return createBounds3([0, 0, 0], [0, 0, 0]);
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i += 1) {
    const base = offset + i * stride;
    const x = positions[base]!;
    const y = positions[base + 1]!;
    const z = positions[base + 2]!;

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`Non-finite position value encountered at vertex ${i}: [${x}, ${y}, ${z}].`);
    }

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;

    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return createBounds3([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/**
 * Merges two Bounds3 boxes into their smallest encompassing bounding box.
 */
export function mergeBounds3(first: Bounds3, second: Bounds3): Bounds3 {
  return createBounds3(
    [
      Math.min(first.min[0], second.min[0]),
      Math.min(first.min[1], second.min[1]),
      Math.min(first.min[2], second.min[2])
    ],
    [
      Math.max(first.max[0], second.max[0]),
      Math.max(first.max[1], second.max[1]),
      Math.max(first.max[2], second.max[2])
    ]
  );
}

import type { Vec3 } from '../math/types';
import { defineResource } from '../ecs/resource';
import { DEFAULT_CELL_SIZE } from './constants';
import type { WorldPosition } from './types';

const originCells = new WeakMap<WorldOrigin, Vec3>();

/**
 * Manages the floating origin grid cell coordinates and cell size.
 *
 * Floating origin rebasing prevents 32-bit floating point precision loss
 * when simulating and rendering large-scale virtual worlds.
 */
export class WorldOrigin {
  readonly cellSize: number;

  /**
   * Creates a new WorldOrigin instance.
   * @param cellSize Size of each cubic coordinate grid cell (must be a positive finite number).
   * @param cell Initial integer cell coordinates [cx, cy, cz].
   */
  constructor(cellSize = DEFAULT_CELL_SIZE, cell: Vec3 = [0, 0, 0]) {
    assertCellSize(cellSize);
    assertCell(cell);
    this.cellSize = cellSize;
    originCells.set(this, [...cell] as Vec3);
  }

  /**
   * Returns a copy of the current integer cell coordinates [cx, cy, cz].
   */
  get cell(): Vec3 {
    return [...requireOriginCell(this)] as Vec3;
  }
}

/** TransformRuntime-only mutation seam; intentionally omitted from the package barrel. */
export function updateWorldOrigin(origin: WorldOrigin, cell: Vec3): void {
  assertCell(cell);
  originCells.set(origin, [...cell] as Vec3);
}

/**
 * Normalizes a large-world coordinate by shifting offset overflows into cell index increments.
 *
 * Ensures that the continuous sub-cell offset along each axis remains within `[-cellSize/2, cellSize/2]`.
 *
 * @param position Raw world position consisting of cell index and offset vector.
 * @param cellSize The dimension of each grid cell.
 * @returns A new immutable normalized `WorldPosition`.
 */
export function normalizeWorldPosition(position: WorldPosition, cellSize: number): WorldPosition {
  assertCellSize(cellSize);
  assertCell(position.cell);
  assertFiniteVector(position.offset, 'World position offset');
  const cell = [...position.cell] as [number, number, number];
  const offset = [...position.offset] as [number, number, number];
  const half = cellSize * 0.5;
  for (let axis = 0; axis < 3; axis++) {
    const shift = Math.floor((offset[axis]! + half) / cellSize);
    cell[axis] = cell[axis]! + shift;
    offset[axis] = offset[axis]! - shift * cellSize;
  }
  if (!cell.every(Number.isSafeInteger)) {
    throw new Error('Normalized world position exceeds the safe integer cell range.');
  }
  return {
    cell: cell as Vec3,
    offset: offset as Vec3
  };
}

/**
 * Converts a large-world coordinate into a continuous 3D position vector relative to the active WorldOrigin.
 *
 * @param position Absolute world position (cell + offset).
 * @param origin Active world origin reference.
 * @returns Localized 3D vector [x, y, z] relative to the current origin cell.
 */
export function worldPositionRelativeToOrigin(position: WorldPosition, origin: WorldOrigin): Vec3 {
  assertCell(position.cell);
  assertFiniteVector(position.offset, 'World position offset');
  return [
    (position.cell[0] - origin.cell[0]) * origin.cellSize + position.offset[0],
    (position.cell[1] - origin.cell[1]) * origin.cellSize + position.offset[1],
    (position.cell[2] - origin.cell[2]) * origin.cellSize + position.offset[2]
  ];
}

function assertCellSize(cellSize: number): void {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error('World origin cellSize must be a positive finite number.');
  }
}

function assertCell(cell: Vec3): void {
  if (
    !cell.every((value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
  ) {
    throw new Error('World origin cells must contain signed 32-bit integers.');
  }
}

function requireOriginCell(origin: WorldOrigin): Vec3 {
  const cell = originCells.get(origin);
  if (!cell) {
    throw new Error('WorldOrigin was not initialized by its constructor.');
  }
  return cell;
}

function assertFiniteVector(vector: Vec3, label: string): void {
  if (!vector.every(Number.isFinite)) {
    throw new Error(`${label} must contain only finite numbers.`);
  }
}

/**
 * ECS Resource token for accessing the active `WorldOrigin`.
 */
export const WorldOriginResource = defineResource<WorldOrigin>('aether.transform.world-origin');

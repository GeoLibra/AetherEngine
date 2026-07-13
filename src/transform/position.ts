import type { Vec3 } from '../math';
import type { WorldPosition } from './types';

const DEFAULT_CELL_SIZE = 1_000;
const originCells = new WeakMap<WorldOrigin, Vec3>();

export class WorldOrigin {
  readonly cellSize: number;

  constructor(cellSize = DEFAULT_CELL_SIZE, cell: Vec3 = [0, 0, 0]) {
    assertCellSize(cellSize);
    assertCell(cell);
    this.cellSize = cellSize;
    originCells.set(this, [...cell] as Vec3);
  }

  get cell(): Vec3 {
    return [...requireOriginCell(this)] as Vec3;
  }
}

/** TransformRuntime-only mutation seam; intentionally omitted from the package barrel. */
export function updateWorldOrigin(origin: WorldOrigin, cell: Vec3): void {
  assertCell(cell);
  originCells.set(origin, [...cell] as Vec3);
}

export function normalizeWorldPosition(
  position: WorldPosition,
  cellSize: number
): WorldPosition {
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
  return Object.freeze({
    cell: Object.freeze(cell) as Vec3,
    offset: Object.freeze(offset) as Vec3
  });
}

export function worldPositionRelativeToOrigin(
  position: WorldPosition,
  origin: WorldOrigin
): Vec3 {
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
    !cell.every(
      (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
    )
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

import { compareCodeUnits } from '../../core';
import type {
  ShadowAtlasCompactionResult,
  ShadowAtlasMetrics,
  ShadowAtlasRelocation,
  ShadowAtlasTileHandle
} from './types';

interface FreeRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface AtlasPacking {
  readonly tiles: ReadonlyMap<string, ShadowAtlasTileHandle>;
  readonly free: readonly FreeRectangle[];
}

/** Deterministic square-tile allocator with exact hole reclamation and explicit compaction. */
export class ShadowAtlasAllocator {
  private generationValue: number;
  private widthValue: number;
  private heightValue: number;
  private readonly tiles = new Map<string, ShadowAtlasTileHandle>();
  private free: FreeRectangle[];

  constructor(options: {
    readonly width: number;
    readonly height: number;
    readonly generation?: number;
  }) {
    validateExtent(options.width, 'width');
    validateExtent(options.height, 'height');
    this.widthValue = options.width;
    this.heightValue = options.height;
    this.generationValue = options.generation ?? 1;
    validateGeneration(this.generationValue);
    this.free = [fullRectangle(this.widthValue, this.heightValue)];
  }

  get generation(): number {
    return this.generationValue;
  }

  allocate(key: string, resolution: number): ShadowAtlasTileHandle | undefined {
    validateKey(key);
    validateExtent(resolution, 'tile resolution');
    const existing = this.tiles.get(key);
    if (existing?.width === resolution && existing.generation === this.generationValue) {
      return existing;
    }
    if (existing) {
      this.tiles.delete(key);
      this.rebuildFreeRectangles();
    }
    const tile = allocateTile(this.free, key, resolution, this.generationValue);
    if (tile === undefined) {
      if (existing) {
        this.tiles.set(key, existing);
        this.rebuildFreeRectangles();
      }
      return undefined;
    }
    this.tiles.set(key, tile);
    this.free = subtractFromFree(this.free, tile);
    return tile;
  }

  release(key: string): boolean {
    const released = this.tiles.delete(key);
    if (released) this.rebuildFreeRectangles();
    return released;
  }

  isValid(handle: ShadowAtlasTileHandle): boolean {
    return handle.generation === this.generationValue && this.tiles.get(handle.key) === handle;
  }

  /** Repacking moves UVs, so every previous handle is invalidated by one generation change. */
  compact(): ShadowAtlasCompactionResult | undefined {
    const nextGeneration = incrementGeneration(this.generationValue);
    const requests = [...this.tiles.values()]
      .map((tile) => ({ key: tile.key, resolution: tile.width, previous: tile }))
      .sort(
        (left, right) => right.resolution - left.resolution || compareCodeUnits(left.key, right.key)
      );
    const packed = packRequests(
      requests.map(({ key, resolution }) => ({ key, resolution })),
      this.widthValue,
      this.heightValue,
      nextGeneration
    );
    if (packed === undefined) return undefined;
    const relocations: ShadowAtlasRelocation[] = requests.map(({ key, previous }) =>
      Object.freeze({ key, previous, next: packed.tiles.get(key)! })
    );
    this.generationValue = nextGeneration;
    replaceMap(this.tiles, packed.tiles);
    this.free = [...packed.free];
    return Object.freeze({
      generation: this.generationValue,
      relocations: Object.freeze(relocations)
    });
  }

  resize(width: number, height: number): void {
    validateExtent(width, 'width');
    validateExtent(height, 'height');
    this.widthValue = width;
    this.heightValue = height;
    this.invalidate();
  }

  invalidate(): void {
    this.generationValue = incrementGeneration(this.generationValue);
    this.tiles.clear();
    this.free = [fullRectangle(this.widthValue, this.heightValue)];
  }

  metrics(): ShadowAtlasMetrics {
    const allocatedTexels = [...this.tiles.values()].reduce(
      (sum, tile) => sum + tile.width * tile.height,
      0
    );
    return Object.freeze({
      generation: this.generationValue,
      width: this.widthValue,
      height: this.heightValue,
      allocatedTiles: this.tiles.size,
      allocatedTexels,
      occupancy: allocatedTexels / (this.widthValue * this.heightValue)
    });
  }

  private rebuildFreeRectangles(): void {
    let free: readonly FreeRectangle[] = [fullRectangle(this.widthValue, this.heightValue)];
    const occupied = [...this.tiles.values()].sort(
      (left, right) => left.y - right.y || left.x - right.x || compareCodeUnits(left.key, right.key)
    );
    for (const tile of occupied) free = subtractFromFree(free, tile);
    this.free = [...free];
  }
}

function packRequests(
  requests: readonly Readonly<{ key: string; resolution: number }>[],
  width: number,
  height: number,
  generation: number
): AtlasPacking | undefined {
  // The packing result is consumed by compact() before any tile becomes public. Keep its
  // scratch containers owner-private; compact() publishes frozen relocation snapshots.
  const tiles = new Map<string, ShadowAtlasTileHandle>();
  let free: readonly FreeRectangle[] = [fullRectangle(width, height)];
  for (const request of requests) {
    const tile = allocateTile(free, request.key, request.resolution, generation);
    if (tile === undefined) return undefined;
    tiles.set(request.key, tile);
    free = subtractFromFree(free, tile);
  }
  return { tiles, free };
}

function allocateTile(
  free: readonly FreeRectangle[],
  key: string,
  resolution: number,
  generation: number
): ShadowAtlasTileHandle | undefined {
  const rectangle = [...free]
    .filter((candidate) => candidate.width >= resolution && candidate.height >= resolution)
    .sort(
      (left, right) =>
        left.y - right.y ||
        left.x - right.x ||
        left.width * left.height - right.width * right.height
    )[0];
  if (rectangle === undefined) return undefined;
  return Object.freeze({
    key,
    generation,
    x: rectangle.x,
    y: rectangle.y,
    width: resolution,
    height: resolution
  });
}

function subtractFromFree(
  free: readonly FreeRectangle[],
  occupied: Readonly<{ x: number; y: number; width: number; height: number }>
): FreeRectangle[] {
  return pruneContainedRectangles(
    free.flatMap((rectangle) => subtractRectangle(rectangle, occupied))
  );
}

function subtractRectangle(
  free: FreeRectangle,
  occupied: Readonly<{ x: number; y: number; width: number; height: number }>
): FreeRectangle[] {
  const left = Math.max(free.x, occupied.x);
  const top = Math.max(free.y, occupied.y);
  const right = Math.min(free.x + free.width, occupied.x + occupied.width);
  const bottom = Math.min(free.y + free.height, occupied.y + occupied.height);
  if (left >= right || top >= bottom) return [free];
  // MaxRects keeps overlapping maximal candidates. A disjoint partition would lose valid
  // placements that span two adjacent partition fragments after a smaller tile is inserted.
  return [
    rectangle(free.x, free.y, free.width, top - free.y),
    rectangle(free.x, bottom, free.width, free.y + free.height - bottom),
    rectangle(free.x, free.y, left - free.x, free.height),
    rectangle(right, free.y, free.x + free.width - right, free.height)
  ].filter((value): value is FreeRectangle => value !== undefined);
}

function pruneContainedRectangles(rectangles: readonly FreeRectangle[]): FreeRectangle[] {
  return rectangles.filter(
    (candidate, index) =>
      !rectangles.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          containsRectangle(other, candidate) &&
          (!containsRectangle(candidate, other) || otherIndex < index)
      )
  );
}

function containsRectangle(container: FreeRectangle, candidate: FreeRectangle): boolean {
  return (
    container.x <= candidate.x &&
    container.y <= candidate.y &&
    container.x + container.width >= candidate.x + candidate.width &&
    container.y + container.height >= candidate.y + candidate.height
  );
}

function rectangle(x: number, y: number, width: number, height: number): FreeRectangle | undefined {
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function fullRectangle(width: number, height: number): FreeRectangle {
  return { x: 0, y: 0, width, height };
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function validateKey(key: string): void {
  if (!key) throw new Error('Shadow atlas tile key must be non-empty.');
}

function validateExtent(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Shadow atlas generation must be a positive integer.');
  }
}

function incrementGeneration(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new Error('Shadow atlas generation is exhausted.');
  return value + 1;
}

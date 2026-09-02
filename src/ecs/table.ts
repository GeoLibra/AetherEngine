import { DEFAULT_TABLE_CHUNK_CAPACITY, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY } from './constants';
import type { Entity, PackedComponentSchema } from './types';

export interface TableRemoval {
  readonly removed: Entity;
  readonly moved?: Entity;
}

export interface ComponentStorage {
  readonly buffer: ArrayBuffer;
  readonly row: number;
}

export interface TableOptions {
  readonly id?: number;
  readonly initialChunkCapacity?: number;
  readonly chunkCapacity?: number;
}

interface EntityChunk {
  readonly rows: Float64Array;
  readonly capacity: number;
}

interface RowLocation {
  readonly chunkIndex: number;
  readonly rowInChunk: number;
}

interface TableColumn {
  readonly schema: PackedComponentSchema<object>;
  readonly chunks: ArrayBuffer[];
}

export class Table {
  readonly id: number;
  readonly archetypeId: string;
  readonly componentTypes: readonly PackedComponentSchema<object>[];

  // Tags are zero-sized archetype members for tag components and relation types.
  readonly tags: ReadonlySet<string>;

  private readonly columns = new Map<string, TableColumn>();
  private readonly entityChunks: EntityChunk[] = [];
  private readonly initialChunkCapacity: number;
  private readonly chunkCapacity: number;
  private allocatedRows = 0;
  private count = 0;

  constructor(
    componentTypes: readonly PackedComponentSchema<object>[],
    tags: readonly string[] = [],
    options: TableOptions = {}
  ) {
    this.id = resolveTableId(options.id);
    this.componentTypes = [...componentTypes].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    this.tags = new Set([...tags].sort());
    this.archetypeId = createArchetypeId(this.componentTypes, this.tags);
    this.initialChunkCapacity = resolveChunkCapacity(
      options.initialChunkCapacity,
      DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY,
      'initialChunkCapacity'
    );
    this.chunkCapacity = resolveChunkCapacity(
      options.chunkCapacity,
      DEFAULT_TABLE_CHUNK_CAPACITY,
      'chunkCapacity'
    );
    for (const schema of this.componentTypes) {
      this.columns.set(schema.id, { schema, chunks: [] });
    }
    this.allocateChunk();
  }

  insert(entity: Entity, components: ReadonlyMap<string, ArrayBuffer>): number {
    if (this.count >= this.capacity) {
      this.allocateChunk();
    }

    const row = this.count;
    const location = this.locateRow(row);
    this.entityChunks[location.chunkIndex]!.rows[location.rowInChunk] = entity;

    for (const schema of this.componentTypes) {
      const data = components.get(schema.id) ?? new ArrayBuffer(schema.size);
      this.writeComponent(schema, row, data);
    }

    this.count++;
    return row;
  }

  remove(row: number): TableRemoval | null {
    if (row < 0 || row >= this.count) {
      return null;
    }

    const lastRow = this.count - 1;
    const removed = this.getEntityAt(row);
    let moved: Entity | undefined;

    if (row !== lastRow) {
      // Swap-remove keeps deletion O(1). World must update the moved entity's row afterward.
      moved = this.getEntityAt(lastRow);
      this.setEntity(row, moved);

      for (const schema of this.componentTypes) {
        this.copyComponent(schema, lastRow, row);
      }
    }

    this.count--;
    return moved === undefined ? { removed } : { removed, moved };
  }

  hasComponent(componentId: string): boolean {
    return this.columns.has(componentId);
  }

  hasTag(tag: string): boolean {
    return this.tags.has(tag);
  }

  getComponentStorage(componentId: string, row: number): ComponentStorage {
    const column = this.getRequiredTableColumn(componentId);
    const location = this.locateExistingRow(row);
    const buffer = column.chunks[location.chunkIndex];
    if (!buffer) {
      throw new Error(`Component "${componentId}" chunk ${location.chunkIndex} is missing.`);
    }
    return { buffer, row: location.rowInChunk };
  }

  getEntity(row: number): Entity {
    return this.getEntityAt(row);
  }

  readComponent(schema: PackedComponentSchema<object>, row: number): ArrayBuffer {
    const data = new ArrayBuffer(schema.size);
    const { buffer, row: rowInChunk } = this.getComponentStorage(schema.id, row);
    new Uint8Array(data).set(new Uint8Array(buffer, rowInChunk * schema.size, schema.size));
    return data;
  }

  writeComponent(schema: PackedComponentSchema<object>, row: number, data: ArrayBuffer): void {
    if (data.byteLength !== schema.size) {
      throw new Error(
        `Component "${schema.name}" expected ${schema.size} bytes, received ${data.byteLength}.`
      );
    }

    const { buffer, row: rowInChunk } = this.getWritableComponentStorage(schema.id, row);
    new Uint8Array(buffer, rowInChunk * schema.size, schema.size).set(new Uint8Array(data));
  }

  get length(): number {
    return this.count;
  }

  get allocatedCapacity(): number {
    return this.allocatedRows;
  }

  get chunkCount(): number {
    return this.entityChunks.length;
  }

  shrinkToFit(): void {
    const requiredChunks = this.getRequiredChunkCountForLength(this.count);
    if (requiredChunks === this.entityChunks.length) {
      return;
    }

    this.entityChunks.length = requiredChunks;
    for (const column of this.columns.values()) {
      column.chunks.length = requiredChunks;
    }
    this.allocatedRows = this.entityChunks.reduce((total, chunk) => total + chunk.capacity, 0);
  }

  private get capacity(): number {
    return this.allocatedRows;
  }

  private allocateChunk(): void {
    const capacity =
      this.entityChunks.length === 0 ? this.initialChunkCapacity : this.chunkCapacity;
    this.entityChunks.push({
      rows: new Float64Array(capacity),
      capacity
    });

    for (const column of this.columns.values()) {
      column.chunks.push(new ArrayBuffer(column.schema.size * capacity));
    }
    this.allocatedRows += capacity;
  }

  private copyComponent(
    schema: PackedComponentSchema<object>,
    sourceRow: number,
    targetRow: number
  ): void {
    const source = this.getComponentStorage(schema.id, sourceRow);
    const target = this.getComponentStorage(schema.id, targetRow);
    new Uint8Array(target.buffer, target.row * schema.size, schema.size).set(
      new Uint8Array(source.buffer, source.row * schema.size, schema.size)
    );
  }

  private getEntityAt(row: number): Entity {
    const location = this.locateExistingRow(row);
    return this.entityChunks[location.chunkIndex]!.rows[location.rowInChunk] as Entity;
  }

  private setEntity(row: number, entity: Entity): void {
    const location = this.locateExistingRow(row);
    this.entityChunks[location.chunkIndex]!.rows[location.rowInChunk] = entity;
  }

  private getRequiredTableColumn(componentId: string): TableColumn {
    const column = this.columns.get(componentId);
    if (!column) {
      throw new Error(`Component "${componentId}" is not present in table "${this.archetypeId}".`);
    }
    return column;
  }

  private getWritableComponentStorage(componentId: string, row: number): ComponentStorage {
    const column = this.getRequiredTableColumn(componentId);
    const location = this.locateWritableRow(row);
    const buffer = column.chunks[location.chunkIndex];
    if (!buffer) {
      throw new Error(`Component "${componentId}" chunk ${location.chunkIndex} is missing.`);
    }
    return { buffer, row: location.rowInChunk };
  }

  private locateExistingRow(row: number): RowLocation {
    if (row < 0 || row >= this.count) {
      throw new Error(`Row ${row} is outside table "${this.archetypeId}" length ${this.count}.`);
    }
    return this.locateRow(row);
  }

  private locateWritableRow(row: number): RowLocation {
    if (row < 0 || row > this.count || row >= this.capacity) {
      throw new Error(
        `Row ${row} is outside writable table "${this.archetypeId}" capacity ${this.capacity}.`
      );
    }
    return this.locateRow(row);
  }

  private locateRow(row: number): RowLocation {
    const firstChunk = this.entityChunks[0];
    if (firstChunk && row < firstChunk.capacity) {
      return { chunkIndex: 0, rowInChunk: row };
    }

    const rowAfterInitialChunk = row - (firstChunk?.capacity ?? this.initialChunkCapacity);
    return {
      chunkIndex: 1 + Math.floor(rowAfterInitialChunk / this.chunkCapacity),
      rowInChunk: rowAfterInitialChunk % this.chunkCapacity
    };
  }

  private getRequiredChunkCountForLength(length: number): number {
    if (length === 0) {
      return 0;
    }
    if (length <= this.initialChunkCapacity) {
      return 1;
    }
    return 1 + Math.ceil((length - this.initialChunkCapacity) / this.chunkCapacity);
  }
}

function resolveTableId(value: number | undefined): number {
  const id = value ?? 0;
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('Table id must be a non-negative safe integer.');
  }
  return id;
}

function resolveChunkCapacity(value: number | undefined, fallback: number, label: string): number {
  const capacity = value ?? fallback;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`Table ${label} must be a positive integer.`);
  }
  return capacity;
}

export function createArchetypeId(
  componentTypes: readonly PackedComponentSchema<object>[],
  tags: Iterable<string> = []
): string {
  // Sorting makes archetype identity independent from insertion order.
  const componentPart = [...componentTypes]
    .map((componentType) => componentType.id)
    .sort()
    .join(',');
  const tagPart = [...tags].sort().join(',');

  return `${componentPart}|${tagPart}`;
}

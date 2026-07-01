import { DEFAULT_TABLE_CAPACITY } from './constants';
import type { ComponentSchema, Entity } from './types';

export interface TableRemoval {
  readonly removed: Entity;
  readonly moved?: Entity;
}

export class Table {
  readonly archetypeId: string;
  readonly componentTypes: readonly ComponentSchema<object>[];

  private readonly columns = new Map<string, ArrayBuffer>();
  private entities = new Uint32Array(0);
  private capacity = 0;
  private count = 0;

  constructor(componentTypes: readonly ComponentSchema<object>[]) {
    this.componentTypes = [...componentTypes].sort((left, right) => left.name.localeCompare(right.name));
    this.archetypeId = this.componentTypes.map((componentType) => componentType.name).join(',');
    this.allocate(DEFAULT_TABLE_CAPACITY);
  }

  insert(entity: Entity, components: ReadonlyMap<string, ArrayBuffer>): number {
    if (this.count >= this.capacity) {
      this.allocate(this.capacity * 2);
    }

    const row = this.count;
    this.entities[row] = entity;

    for (const schema of this.componentTypes) {
      const data = components.get(schema.name) ?? new ArrayBuffer(schema.size);
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
    const removed = this.entities[row] as Entity;
    let moved: Entity | undefined;

    if (row !== lastRow) {
      moved = this.entities[lastRow] as Entity;
      this.entities[row] = moved;

      for (const schema of this.componentTypes) {
        const column = new Uint8Array(this.getRequiredColumn(schema.name));
        column.copyWithin(row * schema.size, lastRow * schema.size, lastRow * schema.size + schema.size);
      }
    }

    this.count--;
    return moved === undefined ? { removed } : { removed, moved };
  }

  hasComponent(componentName: string): boolean {
    return this.columns.has(componentName);
  }

  getColumnBuffer(componentName: string): ArrayBuffer | undefined {
    return this.columns.get(componentName);
  }

  getRequiredColumn(componentName: string): ArrayBuffer {
    const column = this.columns.get(componentName);
    if (!column) {
      throw new Error(`Component "${componentName}" is not present in table "${this.archetypeId}".`);
    }
    return column;
  }

  getEntity(row: number): Entity {
    return this.entities[row] as Entity;
  }

  readComponent(schema: ComponentSchema<object>, row: number): ArrayBuffer {
    const data = new ArrayBuffer(schema.size);
    const column = this.getRequiredColumn(schema.name);
    new Uint8Array(data).set(new Uint8Array(column, row * schema.size, schema.size));
    return data;
  }

  writeComponent(schema: ComponentSchema<object>, row: number, data: ArrayBuffer): void {
    if (data.byteLength !== schema.size) {
      throw new Error(
        `Component "${schema.name}" expected ${schema.size} bytes, received ${data.byteLength}.`
      );
    }

    const column = this.getRequiredColumn(schema.name);
    new Uint8Array(column, row * schema.size, schema.size).set(new Uint8Array(data));
  }

  get length(): number {
    return this.count;
  }

  private allocate(newCapacity: number): void {
    const nextEntities = new Uint32Array(newCapacity);
    nextEntities.set(this.entities.subarray(0, this.count));
    this.entities = nextEntities;

    for (const schema of this.componentTypes) {
      const previous = this.columns.get(schema.name);
      const next = new ArrayBuffer(schema.size * newCapacity);
      if (previous) {
        new Uint8Array(next).set(new Uint8Array(previous, 0, schema.size * this.count));
      }
      this.columns.set(schema.name, next);
    }

    this.capacity = newCapacity;
  }
}

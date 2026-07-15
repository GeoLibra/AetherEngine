import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TABLE_CHUNK_CAPACITY,
  DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY
} from '../../src/ecs/constants';
import { defineComponent, type Entity } from '../../src';
import { Table } from '../../src/ecs/table';

interface CounterView {
  value: number;
}

const Counter = defineComponent<CounterView>({
  id: 'test.counter',
  version: 1,
  name: 'Counter',
  fields: [{ id: 'value', name: 'value', type: 'u32' }]
});

function counterData(value: number): ArrayBuffer {
  const data = new ArrayBuffer(Counter.size);
  new DataView(data).setUint32(0, value, true);
  return data;
}

function entityHandle(value: number): Entity {
  return value as Entity;
}

describe('Table chunk storage', () => {
  test('preserves world-scoped entity handles above 32 bits', () => {
    const table = new Table([Counter]);
    const entity = entityHandle(2 ** 32 + 17);

    table.insert(entity, new Map([[Counter.id, counterData(1)]]));

    expect(table.getEntity(0)).toBe(entity);
  });

  test('starts cold archetypes with a small initial chunk', () => {
    const table = new Table([Counter]);

    table.insert(entityHandle(0), new Map([[Counter.id, counterData(0)]]));

    expect(table.allocatedCapacity).toBe(DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY);
    expect(table.getComponentStorage(Counter.id, 0).buffer.byteLength).toBe(
      Counter.size * DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY
    );
  });

  test('allocates packed component rows in configurable chunks instead of reallocating one column buffer', () => {
    const table = new Table([Counter]);

    for (let index = 0; index < DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + DEFAULT_TABLE_CHUNK_CAPACITY + 1; index++) {
      table.insert(entityHandle(index), new Map([[Counter.id, counterData(index)]]));
    }

    const firstStorage = table.getComponentStorage(Counter.id, 0);
    const boundaryStorage = table.getComponentStorage(Counter.id, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY);

    expect(firstStorage.buffer).not.toBe(boundaryStorage.buffer);
    expect(firstStorage.row).toBe(0);
    expect(boundaryStorage.row).toBe(0);
    expect(new DataView(boundaryStorage.buffer).getUint32(0, true)).toBe(DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY);

    table.writeComponent(Counter, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + 1, counterData(999));

    expect(new DataView(table.readComponent(Counter, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + 1)).getUint32(0, true)).toBe(999);
  });

  test('supports custom cold-start and growth chunk capacities', () => {
    const table = new Table([Counter], [], { initialChunkCapacity: 2, chunkCapacity: 3 });

    for (let index = 0; index < 5; index++) {
      table.insert(entityHandle(index), new Map([[Counter.id, counterData(index)]]));
    }

    expect(table.allocatedCapacity).toBe(5);
    expect(table.getComponentStorage(Counter.id, 0).buffer.byteLength).toBe(Counter.size * 2);
    expect(table.getComponentStorage(Counter.id, 2).buffer.byteLength).toBe(Counter.size * 3);
  });

  test('shrinks trailing empty chunks and can allocate again after a full clear', () => {
    const table = new Table([Counter], [], { initialChunkCapacity: 2, chunkCapacity: 3 });

    for (let index = 0; index < 8; index++) {
      table.insert(entityHandle(index), new Map([[Counter.id, counterData(index)]]));
    }

    expect(table.allocatedCapacity).toBe(8);

    for (let index = 0; index < 6; index++) {
      table.remove(table.length - 1);
    }
    table.shrinkToFit();

    expect(table.length).toBe(2);
    expect(table.allocatedCapacity).toBe(2);
    expect([...Array.from({ length: table.length }, (_value, row) => table.getEntity(row))].sort()).toEqual([0, 1]);

    table.remove(0);
    table.remove(0);
    table.shrinkToFit();

    expect(table.length).toBe(0);
    expect(table.allocatedCapacity).toBe(0);

    table.insert(entityHandle(99), new Map([[Counter.id, counterData(99)]]));

    expect(table.allocatedCapacity).toBe(2);
    expect(new DataView(table.readComponent(Counter, 0)).getUint32(0, true)).toBe(99);
  });
});

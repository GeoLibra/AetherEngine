import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TABLE_CHUNK_CAPACITY,
  DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY
} from '../../src/ecs/constants';
import { defineComponent, type Entity } from '../../src';
import { Table } from '../../src/ecs/storage';

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

    for (
      let index = 0;
      index < DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + DEFAULT_TABLE_CHUNK_CAPACITY + 1;
      index++
    ) {
      table.insert(entityHandle(index), new Map([[Counter.id, counterData(index)]]));
    }

    const firstStorage = table.getComponentStorage(Counter.id, 0);
    const boundaryStorage = table.getComponentStorage(
      Counter.id,
      DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY
    );

    expect(firstStorage.buffer).not.toBe(boundaryStorage.buffer);
    expect(firstStorage.row).toBe(0);
    expect(boundaryStorage.row).toBe(0);
    expect(new DataView(boundaryStorage.buffer).getUint32(0, true)).toBe(
      DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY
    );

    table.writeComponent(Counter, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + 1, counterData(999));

    expect(
      new DataView(
        table.readComponent(Counter, DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY + 1)
      ).getUint32(0, true)
    ).toBe(999);
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
    expect(
      [...Array.from({ length: table.length }, (_value, row) => table.getEntity(row))].sort()
    ).toEqual([0, 1]);

    table.remove(0);
    table.remove(0);
    table.shrinkToFit();

    expect(table.length).toBe(0);
    expect(table.allocatedCapacity).toBe(0);

    table.insert(entityHandle(99), new Map([[Counter.id, counterData(99)]]));

    expect(table.allocatedCapacity).toBe(2);
    expect(new DataView(table.readComponent(Counter, 0)).getUint32(0, true)).toBe(99);
  });

  test('maintains sorted component types, tags set, and deterministic archetype signature', () => {
    const Position = defineComponent<{ x: number; y: number }>({
      id: 'test.position',
      version: 1,
      name: 'Position',
      fields: [
        { id: 'x', name: 'x', type: 'f32' },
        { id: 'y', name: 'y', type: 'f32' }
      ]
    });

    // Provide unsorted components and tags
    const table = new Table(
      [Position, Counter],
      ['tag:visible', 'component:test.metadata', 'tag:active']
    );

    expect(table.componentTypes.map((c) => c.id)).toEqual(['test.counter', 'test.position']);
    expect([...table.tags]).toEqual(['component:test.metadata', 'tag:active', 'tag:visible']);
    expect(table.archetypeId).toBe(
      'test.counter,test.position|component:test.metadata,tag:active,tag:visible'
    );

    expect(table.hasComponent('test.counter')).toBe(true);
    expect(table.hasComponent('test.position')).toBe(true);
    expect(table.hasComponent('unknown.component')).toBe(false);

    expect(table.hasTag('tag:visible')).toBe(true);
    expect(table.hasTag('tag:active')).toBe(true);
    expect(table.hasTag('component:test.metadata')).toBe(true);
    expect(table.hasTag('tag:unknown')).toBe(false);
  });

  test('handles tag-only archetypes and multi-component rows with swap-remove', () => {
    const Position = defineComponent<{ x: number; y: number }>({
      id: 'test.position',
      version: 1,
      name: 'Position',
      fields: [
        { id: 'x', name: 'x', type: 'f32' },
        { id: 'y', name: 'y', type: 'f32' }
      ]
    });

    function positionData(x: number, y: number): ArrayBuffer {
      const data = new ArrayBuffer(Position.size);
      const view = new DataView(data);
      view.setFloat32(0, x, true);
      view.setFloat32(4, y, true);
      return data;
    }

    // Tag-only table
    const tagOnlyTable = new Table([], ['tag:player', 'tag:selected']);
    expect(tagOnlyTable.archetypeId).toBe('|tag:player,tag:selected');
    expect(tagOnlyTable.hasTag('tag:player')).toBe(true);
    expect(tagOnlyTable.hasTag('tag:selected')).toBe(true);
    expect(tagOnlyTable.componentTypes).toHaveLength(0);

    const tagRow0 = tagOnlyTable.insert(entityHandle(10), new Map());
    const tagRow1 = tagOnlyTable.insert(entityHandle(20), new Map());
    expect(tagOnlyTable.getEntity(tagRow0)).toBe(entityHandle(10));
    expect(tagOnlyTable.getEntity(tagRow1)).toBe(entityHandle(20));
    expect(tagOnlyTable.length).toBe(2);

    // Multi-component table with tags
    const multiTable = new Table([Counter, Position], ['tag:moving']);
    const row0 = multiTable.insert(
      entityHandle(1),
      new Map([
        [Counter.id, counterData(10)],
        [Position.id, positionData(1.5, 2.5)]
      ])
    );
    const row1 = multiTable.insert(
      entityHandle(2),
      new Map([
        [Counter.id, counterData(20)],
        [Position.id, positionData(3.5, 4.5)]
      ])
    );

    expect(row0).toBe(0);
    expect(row1).toBe(1);
    expect(multiTable.length).toBe(2);

    // Swap remove row 0: moves row 1 into row 0
    const removal = multiTable.remove(0);
    expect(removal).toEqual({ removed: entityHandle(1), moved: entityHandle(2) });
    expect(multiTable.length).toBe(1);
    expect(multiTable.getEntity(0)).toBe(entityHandle(2));

    const posView = new DataView(multiTable.readComponent(Position, 0));
    expect(posView.getFloat32(0, true)).toBeCloseTo(3.5);
    expect(posView.getFloat32(4, true)).toBeCloseTo(4.5);

    const countView = new DataView(multiTable.readComponent(Counter, 0));
    expect(countView.getUint32(0, true)).toBe(20);
  });
});

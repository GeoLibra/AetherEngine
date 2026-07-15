import { describe, expect, test } from 'vitest';
import { World, defineComponent } from '../../src';
import { ArchetypeCatalog } from '../../src/ecs/archetype-catalog';

interface PositionView {
  x: number;
  y: number;
}

const Position = defineComponent<PositionView>({
  id: 'test.catalog-position',
  version: 1,
  name: 'CatalogPosition',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

const Velocity = defineComponent<PositionView>({
  id: 'test.catalog-velocity',
  version: 1,
  name: 'CatalogVelocity',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

describe('ArchetypeCatalog', () => {
  test('assigns stable numeric ids and reuses transition edges', () => {
    const catalog = new ArchetypeCatalog();
    const empty = catalog.getOrCreate([], []);

    const first = catalog.transition(
      empty,
      'add:component:test.catalog-position',
      [Position],
      []
    );
    const second = catalog.transition(
      empty,
      'add:component:test.catalog-position',
      [Position],
      []
    );

    expect(first).toBe(second);
    expect(first.id).toBeGreaterThan(empty.id);
    expect(catalog.snapshot()).toMatchObject({
      version: 2,
      tableCount: 2,
      migrations: 2,
      edgeHits: 1,
      edgeMisses: 1
    });
  });

  test('assigns distinct stable ids to tables created through World migrations', () => {
    const world = new World();
    world.registerComponent(Position).registerComponent(Velocity);
    world.spawn().insert(Position, { x: 1, y: 2 }).build();
    world.spawn().insert(Position, { x: 3, y: 4 }).insert(Velocity, { x: 5, y: 6 }).build();

    const tables = world.findMatchingTables([Position]);

    expect(tables).toHaveLength(2);
    expect(new Set(tables.map((table) => table.id)).size).toBe(2);
    expect(world.findMatchingTables([Position]).map((table) => table.id)).toEqual(
      tables.map((table) => table.id)
    );
  });
});

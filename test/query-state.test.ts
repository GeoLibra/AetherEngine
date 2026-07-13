import { describe, expect, test } from 'vitest';
import { World, defineComponent } from '../src';

interface VectorView {
  x: number;
  y: number;
}

const Position = defineComponent<VectorView>({
  id: 'test.query-state-position',
  version: 1,
  name: 'QueryStatePosition',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

const Velocity = defineComponent<VectorView>({
  id: 'test.query-state-velocity',
  version: 1,
  name: 'QueryStateVelocity',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

describe('QueryState', () => {
  test('incrementally matches only newly created archetypes', () => {
    const world = new World();
    world.registerComponent(Position).registerComponent(Velocity);
    world.spawn().insert(Position, { x: 1, y: 2 }).build();
    const state = world.createQueryState([Position] as const);

    expect([...state]).toHaveLength(1);
    const initial = state.plan;
    expect(initial.matchedArchetypeIds).toHaveLength(1);
    expect(initial.catalogTablesExamined).toBe(1);

    world
      .spawn()
      .insert(Position, { x: 3, y: 4 })
      .insert(Velocity, { x: 5, y: 6 })
      .build();

    expect([...state]).toHaveLength(2);
    const updated = state.plan;
    expect(updated.catalogTablesExamined - initial.catalogTablesExamined).toBe(1);
    expect(updated.matchedArchetypeIds).toHaveLength(2);

    expect([...state]).toHaveLength(2);
    expect(state.plan.cacheHits).toBe(updated.cacheHits + 1);
  });

  test('keeps world.query as a compatible reusable convenience builder', () => {
    const world = new World();
    world.registerComponent(Position);
    const query = world.query([Position] as const);

    world.spawn().insert(Position, { x: 1, y: 2 }).build();
    expect([...query].map(([entity]) => entity)).toHaveLength(1);

    world.spawn().insert(Position, { x: 3, y: 4 }).build();
    expect([...query].map(([entity]) => entity)).toHaveLength(2);
  });
});

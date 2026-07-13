import { describe, expect, test } from 'vitest';
import { World, defineComponent, defineObjectComponent } from '../src';

interface PositionView {
  x: number;
}

interface LabelView {
  value: string;
}

const Position = defineComponent<PositionView>({
  id: 'test.query-plan-position',
  version: 1,
  name: 'QueryPlanPosition',
  fields: [{ id: 'x', name: 'x', type: 'f32' }]
});

const Label = defineObjectComponent<LabelView>({
  id: 'test.query-plan-label',
  version: 1,
  name: 'QueryPlanLabel',
  fields: [
    {
      id: 'value',
      name: 'value',
      type: { kind: 'string' },
      required: true,
      compare: 'exact',
      serialization: 'save'
    }
  ],
  validate(input) {
    return typeof input === 'object' && input !== null && 'value' in input &&
      typeof input.value === 'string'
      ? { ok: true, value: input as LabelView }
      : { ok: false, issues: [{ path: [], message: 'Invalid label.' }] };
  }
});

describe('Query planner', () => {
  test('reports entity, table, and sparse-object candidate sources', () => {
    const world = new World();
    world.registerComponent(Position).registerComponent(Label);
    world.spawn().build();
    world.spawn().insert(Position, { x: 1 }).build();
    const labelled = world
      .spawn()
      .insert(Position, { x: 2 })
      .insert(Label, { value: 'selected' })
      .build();

    const entities = world.createQueryState([] as const);
    const tables = world.createQueryState([Position] as const);
    const objects = world.createQueryState([Label] as const);

    expect([...entities]).toHaveLength(3);
    expect(entities.plan.candidateSource).toBe('entities');
    expect([...tables]).toHaveLength(2);
    expect(tables.plan.candidateSource).toBe('tables');
    expect([...objects].map(([entity]) => entity)).toEqual([labelled]);
    expect(objects.plan.candidateSource).toBe('object-component');
    expect(objects.plan.rowFilters).toBe(1);
  });
});

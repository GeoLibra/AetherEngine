import { describe, expect, test } from 'vitest';
import { ChildOf, World, defineRelation, type Entity } from '../src';
import { RelationIndex } from '../src/ecs/relation-index';

const References = defineRelation('test.relation-index-references');

function entity(value: number): Entity {
  return value as Entity;
}

describe('RelationIndex', () => {
  test('keeps outgoing, type-source, and target-incoming indexes in sync', () => {
    const index = new RelationIndex();
    const source = entity(1);
    const otherSource = entity(2);
    const target = entity(3);

    index.set(source, { relation: References, target });
    index.set(otherSource, { relation: References, target });

    expect(index.get(source, References)).toEqual({ relation: References, target });
    expect([...index.sources(References)]).toEqual([source, otherSource]);
    expect([...index.incoming(References, target)]).toEqual([source, otherSource]);
    expect(index.incomingTo(target)).toEqual([
      { source, relation: { relation: References, target } },
      { source: otherSource, relation: { relation: References, target } }
    ]);
    expect(index.edgeCount).toBe(2);

    expect(index.remove(source, References)).toEqual({ relation: References, target });
    expect([...index.sources(References)]).toEqual([otherSource]);
    expect([...index.incoming(References, target)]).toEqual([otherSource]);
    expect(index.edgeCount).toBe(1);
  });

  test('uses exact-target candidates and removes incoming relations when a target despawns', () => {
    const world = new World();
    const parent = world.spawn().build();
    const otherParent = world.spawn().build();
    const child = world.spawn().build();
    const otherChild = world.spawn().build();
    world.addRelation(child, ChildOf, parent);
    world.addRelation(otherChild, ChildOf, otherParent);
    const state = world.createQueryState([] as const, { relation: [ChildOf, parent] });

    expect([...state].map(([candidate]) => candidate)).toEqual([child]);
    expect(state.plan.candidateSource).toBe('relation-target');
    expect(state.plan.rowFilters).toBe(1);

    world.despawn(parent);

    expect(world.getRelation(child, ChildOf)).toBeNull();
    expect(world.getRelation(otherChild, ChildOf)?.target).toBe(otherParent);
  });

  test('dispatches one removal event for a self-targeting relation during despawn', () => {
    const world = new World();
    const entity = world.spawn().build();
    const events: Entity[] = [];
    world.addObserver({
      id: 'test.self-relation-removal',
      event: 'relation-removed',
      relation: References,
      run: (event) => events.push(event.entity)
    });
    world.addRelation(entity, References, entity);

    world.despawn(entity);

    expect(events).toEqual([entity]);
  });
});

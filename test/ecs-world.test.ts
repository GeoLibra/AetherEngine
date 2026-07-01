import { describe, expect, test } from 'vitest';
import {
  ChildOf,
  World,
  defineComponent,
  defineRelation,
  type Entity,
  type RelationType
} from '../src';

interface TransformView {
  position: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
}

interface VelocityView {
  linear: Float32Array;
}

const Transform = defineComponent<TransformView>({
  name: 'Transform',
  fields: [
    { name: 'position', type: 'vec3' },
    { name: 'rotation', type: 'vec4' },
    { name: 'scale', type: 'vec3' }
  ]
});

const Velocity = defineComponent<VelocityView>({
  name: 'Velocity',
  fields: [{ name: 'linear', type: 'vec3' }]
});

describe('World entities and components', () => {
  test('invalidates stale entity ids when a slot is reused', () => {
    const world = new World();
    const first = world.spawn().build();

    expect(world.isAlive(first)).toBe(true);
    expect(world.despawn(first)).toBe(true);
    expect(world.isAlive(first)).toBe(false);

    const second = world.spawn().build();

    expect(second).not.toBe(first);
    expect(world.isAlive(second)).toBe(true);
    expect(world.despawn(first)).toBe(false);
  });

  test('stores component data in archetypes and migrates entities when components are added', () => {
    const world = new World();
    world.registerComponent(Transform).registerComponent(Velocity);

    const mover = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })
      .build();
    const staticEntity = world
      .spawn()
      .insert(Transform, { position: [10, 20, 30], scale: [2, 2, 2] })
      .build();

    world.insertComponent(mover, Velocity, { linear: [4, 5, 6] });

    const movingRows = [...world.query([Transform, Velocity])];
    expect(movingRows).toHaveLength(1);
    expect(movingRows[0]?.[0]).toBe(mover);
    expect(Array.from(movingRows[0]?.[1].position ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(movingRows[0]?.[2].linear ?? [])).toEqual([4, 5, 6]);

    const transformRows = [...world.query([Transform], { without: [Velocity] })];
    expect(transformRows.map(([entity]) => entity)).toEqual([staticEntity]);
  });

  test('supports typed resources alongside ECS storage', () => {
    class Counter {
      value = 1;
    }

    const world = new World();
    const counter = new Counter();

    world.insertResource(counter);

    expect(world.getResource(Counter)).toBe(counter);
    expect(world.hasResource(Counter)).toBe(true);
    expect(world.removeResource(Counter)).toBe(counter);
    expect(world.hasResource(Counter)).toBe(false);
  });
});

describe('World relationships and queries', () => {
  test('filters by ChildOf relation and traverses descendants in depth order', () => {
    const world = new World();
    world.registerComponent(Transform);

    const root = world.spawn().insert(Transform, { position: [0, 0, 0] }).build();
    const child = world
      .spawn()
      .insert(Transform, { position: [1, 0, 0] })
      .addRelation(ChildOf, root)
      .build();
    const grandchild = world.spawn().addRelation(ChildOf, child).build();

    expect(world.getParent(child)).toBe(root);
    expect(world.getChildren(root)).toEqual([child]);
    expect([...world.query([Transform], { relation: [ChildOf, root] })].map(([entity]) => entity)).toEqual([
      child
    ]);
    expect([...world.query([], { relation: [ChildOf, child] })].map(([entity]) => entity)).toEqual([
      grandchild
    ]);

    const visited: Array<[Entity, number]> = [];
    world.traverseDescendants(root, (entity, depth) => visited.push([entity, depth]));

    expect(visited).toEqual([
      [root, 0],
      [child, 1],
      [grandchild, 2]
    ]);
  });

  test('supports custom relation types', () => {
    const world = new World();
    const Targets: RelationType = defineRelation('Targets');
    const source = world.spawn().build();
    const target = world.spawn().build();

    world.addRelation(source, Targets, target);

    expect(world.getRelation(source, Targets)).toEqual({ relation: Targets, target });
    expect([...world.query([], { relation: [Targets, target] })].map(([entity]) => entity)).toEqual([
      source
    ]);
  });
});

describe('World change detection', () => {
  test('tracks added and changed components until trackers are cleared', () => {
    const world = new World();
    world.registerComponent(Transform);

    const entity = world.spawn().insert(Transform, { position: [1, 2, 3] }).build();

    expect([...world.query([Transform], { added: [Transform] })].map(([row]) => row)).toEqual([entity]);
    expect([...world.query([Transform], { changed: [Transform] })].map(([row]) => row)).toEqual([
      entity
    ]);

    world.clearTrackers();

    expect([...world.query([Transform], { added: [Transform] })]).toEqual([]);
    expect([...world.query([Transform], { changed: [Transform] })]).toEqual([]);

    const transform = world.getComponent<TransformView>(entity, Transform);
    expect(transform).not.toBeNull();
    transform!.position[0] = 42;

    expect([...world.query([Transform], { changed: [Transform] })].map(([row]) => row)).toEqual([
      entity
    ]);
  });
});

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

  test('keeps ChildOf index synchronized when relations are replaced and entities despawn', () => {
    const world = new World();
    const firstParent = world.spawn().build();
    const secondParent = world.spawn().build();
    const child = world.spawn().addRelation(ChildOf, firstParent).build();

    expect(world.getChildren(firstParent)).toEqual([child]);
    expect(world.getChildren(secondParent)).toEqual([]);

    world.addRelation(child, ChildOf, secondParent);

    expect(world.getChildren(firstParent)).toEqual([]);
    expect(world.getChildren(secondParent)).toEqual([child]);

    world.despawn(child);

    expect(world.getChildren(secondParent)).toEqual([]);
  });

  test('keeps relation queries correct after relation removal changes archetype membership', () => {
    const world = new World();
    world.registerComponent(Transform);

    const parent = world.spawn().build();
    const child = world.spawn().insert(Transform, { position: [1, 0, 0] }).build();

    world.addRelation(child, ChildOf, parent);
    expect([...world.query([Transform], { relation: [ChildOf, parent] })].map(([entity]) => entity)).toEqual([
      child
    ]);

    expect(world.removeRelation(child, ChildOf)).toBe(true);

    expect([...world.query([Transform], { relation: [ChildOf, parent] })]).toEqual([]);
    expect([...world.query([Transform])].map(([entity]) => entity)).toContain(child);
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

  test('tracks vector mutating methods as component changes', () => {
    const world = new World();
    world.registerComponent(Transform);
    const entity = world.spawn().insert(Transform, { position: [1, 2, 3] }).build();

    world.clearTrackers();
    world.getComponent<TransformView>(entity, Transform)!.position.set([9, 9, 9]);

    expect([...world.query([Transform], { changed: [Transform] })].map(([row]) => row)).toEqual([
      entity
    ]);

    world.clearTrackers();
    world.getComponent<TransformView>(entity, Transform)!.scale.fill(2);

    expect([...world.query([Transform], { changed: [Transform] })].map(([row]) => row)).toEqual([
      entity
    ]);
  });

  test('keeps existing component views valid after table reallocation', () => {
    const world = new World();
    world.registerComponent(Transform);
    const entity = world.spawn().insert(Transform, { position: [1, 2, 3] }).build();
    const beforeGrowth = world.getComponent<TransformView>(entity, Transform);

    for (let index = 0; index < 100; index++) {
      world.spawn().insert(Transform, { position: [0, 0, 0] }).build();
    }

    beforeGrowth!.position[0] = 42;

    expect(world.getComponent<TransformView>(entity, Transform)!.position[0]).toBe(42);
  });

  test('can shrink empty table chunks after scene cleanup', () => {
    const world = new World();
    world.registerComponent(Transform);
    const entities: Entity[] = [];

    for (let index = 0; index < 80; index++) {
      entities.push(world.spawn().insert(Transform, { position: [index, 0, 0] }).build());
    }

    const [table] = world.findMatchingTables([Transform]);
    expect(table?.allocatedCapacity).toBeGreaterThan(0);

    for (const entity of entities) {
      world.despawn(entity);
    }
    world.shrinkTablesToFit();

    expect(table?.allocatedCapacity).toBe(0);
  });

  test('keeps existing component views valid after archetype migrations', () => {
    const world = new World();
    world.registerComponent(Transform).registerComponent(Velocity);
    const parent = world.spawn().build();
    const entity = world.spawn().insert(Transform, { position: [1, 2, 3] }).build();
    const transform = world.getComponent<TransformView>(entity, Transform);

    world.insertComponent(entity, Velocity, { linear: [1, 0, 0] });
    world.addRelation(entity, ChildOf, parent);

    transform!.position[0] = 77;

    expect(world.getComponent<TransformView>(entity, Transform)!.position[0]).toBe(77);
    expect([...world.query([Transform, Velocity], { relation: [ChildOf, parent] })].map(([row]) => row)).toEqual([
      entity
    ]);
  });
});

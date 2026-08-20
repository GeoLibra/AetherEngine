import { describe, expect, test } from 'vitest';
import {
  ChildOf,
  World,
  defineComponent,
  defineRelation,
  defineResource,
  type Entity,
  type RelationType,
  type WorldId
} from '../../src';

interface TransformView {
  position: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
}

interface VelocityView {
  linear: Float32Array;
}

interface EntityTargetView {
  target: Entity;
}

const Transform = defineComponent<TransformView>({
  id: 'test.transform',
  version: 1,
  name: 'Transform',
  fields: [
    { id: 'position', name: 'position', type: 'vec3' },
    { id: 'rotation', name: 'rotation', type: 'vec4' },
    { id: 'scale', name: 'scale', type: 'vec3' }
  ]
});

const Velocity = defineComponent<VelocityView>({
  id: 'test.velocity',
  version: 1,
  name: 'Velocity',
  fields: [{ id: 'linear', name: 'linear', type: 'vec3' }]
});

const EntityTarget = defineComponent<EntityTargetView>({
  id: 'test.entity-target',
  version: 1,
  name: 'EntityTarget',
  fields: [{ id: 'target', name: 'target', type: 'entity' }]
});

describe('World entities and components', () => {
  test('preserves schemas and resources across clear and rejects access after destroy', () => {
    const world = new World();
    const MarkerResource = defineResource<{ value: number }>('test.world-marker');
    const marker = { value: 1 };
    const events: string[] = [];
    world.registerComponent(Transform);
    world.insertResource(MarkerResource, marker);
    world.addObserver({
      id: 'test.clear-component-removed',
      event: 'component-removed',
      component: Transform,
      run: () => events.push('component-removed')
    });
    world.addObserver({
      id: 'test.clear-entity-despawned',
      event: 'entity-despawned',
      run: () => events.push('entity-despawned')
    });
    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .build();

    expect(world.state).toBe('created');
    world.start();
    expect(world.state).toBe('running');

    world.clear();

    expect(world.state).toBe('running');
    expect(world.isAlive(entity)).toBe(false);
    expect(world.isComponentRegistered(Transform)).toBe(true);
    expect(world.getResource(MarkerResource)).toBe(marker);
    expect(events).toEqual(['component-removed', 'entity-despawned']);

    world.destroy();
    world.destroy();

    expect(world.state).toBe('destroyed');
    expect(() => world.spawn()).toThrow('destroyed');
    expect(() => world.getResource(MarkerResource)).toThrow('destroyed');
    expect(() => world.query([])).toThrow('destroyed');
    expect(() => world.isAlive(entity)).toThrow('destroyed');
  });

  test('restores created state after clearing before startup', () => {
    const world = new World();
    world.spawn().build();

    world.clear();

    expect(world.state).toBe('created');
  });

  test('scopes entity handles to their owning World', () => {
    const firstWorld = new World();
    const secondWorld = new World();
    firstWorld.registerComponent(Transform).registerComponent(EntityTarget);

    const local = firstWorld.spawn().build();
    const source = firstWorld.spawn().build();
    const foreign = secondWorld.spawn().build();

    expect(firstWorld.id).not.toBe(secondWorld.id);
    expect(local).not.toBe(foreign);
    expect(() => firstWorld.insertComponent(foreign, Transform, {})).toThrow('cross-world');
    expect(() => firstWorld.insertComponent(local, EntityTarget, { target: foreign })).toThrow(
      'cross-world'
    );
    expect(() => firstWorld.addRelation(source, ChildOf, foreign)).toThrow('cross-world');
    expect(() => firstWorld.hasChanged(foreign, [Transform])).toThrow('cross-world');
    expect(() => firstWorld.query([], { relation: [ChildOf, foreign] })).toThrow('cross-world');
    expect(() => firstWorld.findMatchingTables([], { relation: [ChildOf, foreign] })).toThrow(
      'cross-world'
    );
    expect(() => firstWorld.despawn(foreign)).toThrow('cross-world');
  });

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

  test('retires an entity slot before its generation can wrap', () => {
    const world = new World();
    const first = world.spawn().build();
    world.despawn(first);

    for (let generation = 1; generation <= 4095; generation++) {
      const entity = world.spawn().build();
      expect(world.despawn(entity)).toBe(true);
    }

    const replacement = world.spawn().build();

    expect(replacement).not.toBe(first);
    expect(world.isAlive(first)).toBe(false);
  });

  test('keeps omitted optional entity fields at their empty sentinel', () => {
    const world = new World();
    world.registerComponent(EntityTarget);

    const entity = world.spawn().insert(EntityTarget).build();

    expect(world.getComponent(entity, EntityTarget)?.target).toBe(0);
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

  test('uses stable schema ids rather than display names for component identity', () => {
    const AlternateTransform = defineComponent<{ value: number }>({
      id: 'test.alternate-transform',
      version: 1,
      name: 'Transform',
      fields: [{ id: 'value', name: 'value', type: 'f32' }]
    });
    const world = new World();
    world.registerComponent(Transform).registerComponent(AlternateTransform);

    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .insert(AlternateTransform, { value: 42 })
      .build();

    expect(world.getComponent(entity, AlternateTransform)?.value).toBe(42);
    expect([...world.query([Transform, AlternateTransform])]).toHaveLength(1);
  });

  test('supports typed resources alongside ECS storage', () => {
    class Counter {
      value = 1;
    }

    const world = new World();
    const PrimaryCounter = defineResource<Counter>('test.primary-counter');
    const SecondaryCounter = defineResource<Counter>('test.secondary-counter');
    const primary = new Counter();
    const secondary = new Counter();

    world.insertResource(PrimaryCounter, primary);
    world.insertResource(SecondaryCounter, secondary);

    expect(world.getResource(PrimaryCounter)).toBe(primary);
    expect(world.getResource(SecondaryCounter)).toBe(secondary);
    expect(world.hasResource(PrimaryCounter)).toBe(true);
    expect(world.removeResource(PrimaryCounter)).toBe(primary);
    expect(world.hasResource(PrimaryCounter)).toBe(false);
    expect(world.getResource(SecondaryCounter)).toBe(secondary);

    if (false) {
      // @ts-expect-error Resource insertion requires an explicit typed token.
      world.insertResource(new Counter());
    }
  });
});

describe('World relationships and queries', () => {
  test('filters by ChildOf relation and traverses descendants in depth order', () => {
    const world = new World();
    world.registerComponent(Transform);

    const root = world
      .spawn()
      .insert(Transform, { position: [0, 0, 0] })
      .build();
    const child = world
      .spawn()
      .insert(Transform, { position: [1, 0, 0] })
      .addRelation(ChildOf, root)
      .build();
    const grandchild = world.spawn().addRelation(ChildOf, child).build();

    expect(world.getParent(child)).toBe(root);
    expect(world.getChildren(root)).toEqual([child]);
    expect(
      [...world.query([Transform], { relation: [ChildOf, root] })].map(([entity]) => entity)
    ).toEqual([child]);
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
    expect([...world.query([], { relation: [Targets, target] })].map(([entity]) => entity)).toEqual(
      [source]
    );
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
    const child = world
      .spawn()
      .insert(Transform, { position: [1, 0, 0] })
      .build();

    world.addRelation(child, ChildOf, parent);
    expect(
      [...world.query([Transform], { relation: [ChildOf, parent] })].map(([entity]) => entity)
    ).toEqual([child]);

    expect(world.removeRelation(child, ChildOf)).toBe(true);

    expect([...world.query([Transform], { relation: [ChildOf, parent] })]).toEqual([]);
    expect([...world.query([Transform])].map(([entity]) => entity)).toContain(child);
  });

  test('does not create one archetype per exact relation target', () => {
    const world = new World();
    const Targets = defineRelation('ManyTargets');
    const targets = Array.from({ length: 200 }, () => world.spawn().build());
    for (const target of targets) {
      world.spawn().addRelation(Targets, target).build();
    }

    expect(world.findMatchingTables([], { with: [Targets] })).toHaveLength(1);
    expect([...world.query([], { relation: [Targets, targets[73]!] })]).toHaveLength(1);
  });
});

describe('World change detection', () => {
  test('tracks added and changed components until trackers are cleared', () => {
    const world = new World();
    world.registerComponent(Transform);

    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .build();

    expect([...world.query([Transform], { added: [Transform] })].map(([row]) => row)).toEqual([
      entity
    ]);
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
    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .build();

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
    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .build();
    const beforeGrowth = world.getComponent<TransformView>(entity, Transform);

    for (let index = 0; index < 100; index++) {
      world
        .spawn()
        .insert(Transform, { position: [0, 0, 0] })
        .build();
    }

    beforeGrowth!.position[0] = 42;

    expect(world.getComponent<TransformView>(entity, Transform)!.position[0]).toBe(42);
  });

  test('can shrink empty table chunks after scene cleanup', () => {
    const world = new World();
    world.registerComponent(Transform);
    const entities: Entity[] = [];

    for (let index = 0; index < 80; index++) {
      entities.push(
        world
          .spawn()
          .insert(Transform, { position: [index, 0, 0] })
          .build()
      );
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
    const entity = world
      .spawn()
      .insert(Transform, { position: [1, 2, 3] })
      .build();
    const transform = world.getComponent<TransformView>(entity, Transform);

    world.insertComponent(entity, Velocity, { linear: [1, 0, 0] });
    world.addRelation(entity, ChildOf, parent);

    transform!.position[0] = 77;

    expect(world.getComponent<TransformView>(entity, Transform)!.position[0]).toBe(77);
    expect(
      [...world.query([Transform, Velocity], { relation: [ChildOf, parent] })].map(([row]) => row)
    ).toEqual([entity]);
  });

  test('validates entity encoding bounds and decoding invariants fail-fast', async () => {
    const { encodeEntity, decodeEntity, ENTITY_INDEX_MASK, ENTITY_GENERATION_MASK, MAX_WORLD_ID } =
      await import('../../src/ecs');

    // Valid encode and decode
    const entity = encodeEntity(1 as unknown as WorldId, 42, 7);
    expect(decodeEntity(entity)).toEqual({ worldId: 1, index: 42, generation: 7 });

    // Invalid worldId
    expect(() => encodeEntity(-1 as unknown as WorldId, 0, 0)).toThrow(
      'World id must be between 0'
    );
    expect(() => encodeEntity((MAX_WORLD_ID + 1) as unknown as WorldId, 0, 0)).toThrow(
      'World id must be between 0'
    );
    expect(() => encodeEntity(1.5 as unknown as WorldId, 0, 0)).toThrow(
      'World id must be between 0'
    );
    expect(() => encodeEntity(Number.NaN as unknown as WorldId, 0, 0)).toThrow(
      'World id must be between 0'
    );

    // Invalid index
    expect(() => encodeEntity(1 as unknown as WorldId, -1, 0)).toThrow(
      'Entity index must be between 0'
    );
    expect(() => encodeEntity(1 as unknown as WorldId, ENTITY_INDEX_MASK + 1, 0)).toThrow(
      'Entity index must be between 0'
    );
    expect(() => encodeEntity(1 as unknown as WorldId, 2.5, 0)).toThrow(
      'Entity index must be between 0'
    );

    // Invalid generation
    expect(() => encodeEntity(1 as unknown as WorldId, 0, -1)).toThrow(
      'Entity generation must fit in'
    );
    expect(() => encodeEntity(1 as unknown as WorldId, 0, ENTITY_GENERATION_MASK + 1)).toThrow(
      'Entity generation must fit in'
    );
    expect(() => encodeEntity(1 as unknown as WorldId, 0, 3.14)).toThrow(
      'Entity generation must fit in'
    );

    // Invalid decode entity handle
    expect(() => decodeEntity(-1 as Entity)).toThrow(
      'Entity handle must be a non-negative safe integer'
    );
    expect(() => decodeEntity(Number.NaN as Entity)).toThrow(
      'Entity handle must be a non-negative safe integer'
    );
    expect(() => decodeEntity(1.5 as Entity)).toThrow(
      'Entity handle must be a non-negative safe integer'
    );
    expect(() => decodeEntity(Number.POSITIVE_INFINITY as Entity)).toThrow(
      'Entity handle must be a non-negative safe integer'
    );
  });
});

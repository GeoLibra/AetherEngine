import { describe, expect, test } from 'vitest';
import {
  App,
  ChildOf,
  CommandBufferResource,
  HeadlessRunner,
  World,
  defineComponent,
  definePlugin
} from '../../src';

const Flag = defineComponent<{ value: number }>({
  id: 'test.observer-flag',
  version: 1,
  name: 'ObserverFlag',
  fields: [{ id: 'value', name: 'value', type: 'u32' }]
});

describe('World observers', () => {
  test('orders observers by priority/id and defers their structural commands', () => {
    const world = new World();
    world.registerComponent(Flag);
    const entity = world.spawn().build();
    const events: string[] = [];
    world.addObserver({
      id: 'low',
      event: 'component-added',
      component: Flag,
      priority: 0,
      run() {
        events.push('low');
      }
    });
    world.addObserver({
      id: 'high',
      event: 'component-added',
      component: Flag,
      priority: 10,
      run(event, deferred) {
        events.push('high');
        if (event.entity === entity) {
          deferred.commands.spawn([{ component: Flag, data: { value: 2 } }]);
        }
      }
    });

    world.insertComponent(entity, Flag, { value: 1 });

    expect(events).toEqual(['high', 'low']);
    expect([...world.query([Flag])]).toHaveLength(1);
    world.getResource(CommandBufferResource)!.apply(world, 'observer-deferred');
    expect([...world.query([Flag])]).toHaveLength(2);
  });

  test('makes an added packed component visible during observer dispatch', () => {
    const world = new World();
    world.registerComponent(Flag);
    const entity = world.spawn().build();
    let observedValue: number | undefined;
    world.addObserver({
      id: 'read-added-component',
      event: 'component-added',
      component: Flag,
      run(event, deferred) {
        observedValue = deferred.getComponent(event.entity, Flag)?.value;
      }
    });

    world.insertComponent(entity, Flag, { value: 42 });

    expect(observedValue).toBe(42);
  });

  test('makes an added relation visible and rolls it back when the observer fails', () => {
    const world = new World();
    const parent = world.spawn().build();
    const child = world.spawn().build();
    let observedTarget: number | undefined;
    world.addObserver({
      id: 'read-added-relation',
      event: 'relation-added',
      relation: ChildOf,
      run(event, deferred) {
        observedTarget = deferred.getRelation(event.entity, ChildOf)?.target;
        throw new Error('reject relation');
      }
    });

    expect(() => world.addRelation(child, ChildOf, parent)).toThrow('reject relation');
    expect(observedTarget).toBe(parent);
    expect(world.getRelation(child, ChildOf)).toBeNull();
  });

  test('aborts the mutation and deferred commands when an observer throws', () => {
    const world = new World();
    world.registerComponent(Flag);
    const entity = world.spawn().build();
    world.addObserver({
      id: 'reject',
      event: 'component-added',
      component: Flag,
      run(_event, deferred) {
        deferred.commands.spawn();
        throw new Error('observer rejected');
      }
    });

    expect(() => world.insertComponent(entity, Flag, { value: 1 })).toThrow('observer rejected');
    expect(world.hasComponent(entity, Flag)).toBe(false);
    expect(world.getResource(CommandBufferResource)?.length).toBe(0);
  });

  test('rejects captured-World structural reentrancy during observer dispatch', () => {
    const world = new World();
    world.registerComponent(Flag);
    const entity = world.spawn().build();
    world.addObserver({
      id: 'recursive',
      event: 'component-added',
      component: Flag,
      run() {
        world.spawn();
      }
    });

    expect(() => world.insertComponent(entity, Flag, { value: 1 })).toThrow('observer dispatch');
    expect(world.hasComponent(entity, Flag)).toBe(false);
  });

  test('makes despawn relation observer failures transactional', () => {
    const world = new World();
    const parent = world.spawn().build();
    const child = world.spawn().addRelation(ChildOf, parent).build();
    world.addObserver({
      id: 'reject-relation-removal',
      event: 'relation-removed',
      relation: ChildOf,
      run() {
        throw new Error('keep hierarchy');
      }
    });

    expect(() => world.despawn(parent)).toThrow('keep hierarchy');

    expect(world.isAlive(parent)).toBe(true);
    expect(world.isAlive(child)).toBe(true);
    expect(world.getParent(child)).toBe(parent);
  });

  test('lets plugins register observers transactionally through AppBuilder', async () => {
    const events: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.observer-plugin',
        build(builder) {
          builder.addObserver({
            id: 'plugin-observer',
            event: 'component-added',
            component: Flag,
            run() {
              events.push('added');
            }
          });
          builder.addSystem('Startup', {
            id: 'observer-startup-mutation',
            run(world) {
              world.registerComponent(Flag);
              world.spawn().insert(Flag, { value: 1 }).build();
            }
          });
        }
      })
    );

    await app.run(new HeadlessRunner({ frames: 0 }));

    expect(events).toEqual(['added']);
  });
});

import { describe, expect, test } from 'vitest';
import {
  App,
  ChildOf,
  CommandBuffer,
  CommandBufferResource,
  HeadlessRunner,
  World,
  defineComponent,
  definePlugin
} from '../../src';

const Position = defineComponent<{ x: number }>({
  id: 'test.command-position',
  version: 1,
  name: 'CommandPosition',
  fields: [{ id: 'x', name: 'x', type: 'f32' }]
});

describe('CommandBuffer', () => {
  test('resolves spawn tickets and commits commands in record order', () => {
    const world = new World();
    world.registerComponent(Position);
    const parent = world.spawn().build();
    const commands = new CommandBuffer();
    const child = commands.spawn([{ component: Position, data: { x: 1 } }]);
    commands.insert(child, Position, { x: 2 });
    commands.setRelation(child, ChildOf, parent);

    const result = commands.apply(world, 'test');
    const entity = result.resolve(child);

    expect(world.isAlive(entity)).toBe(true);
    expect(world.getComponent(entity, Position)?.x).toBe(2);
    expect(world.getParent(entity)).toBe(parent);
    expect(result.applyPoint).toBe('test');
    expect(commands.length).toBe(0);
  });

  test('validates the whole batch before commit and preserves World on failure', () => {
    const world = new World();
    world.registerComponent(Position);
    const stale = world.spawn().build();
    world.despawn(stale);
    const commands = new CommandBuffer();
    const pending = commands.spawn([{ component: Position, data: { x: 3 } }]);
    commands.insert(stale, Position, { x: 4 });

    expect(() => commands.apply(world)).toThrow('stale');
    expect([...world.query([])]).toEqual([]);
    expect(() => commands.resolve(pending)).toThrow('not been applied');
    expect(commands.length).toBe(2);
  });

  test('rejects finite JavaScript numbers that overflow packed f32 storage', () => {
    const world = new World();
    world.registerComponent(Position);
    const entity = world.spawn().build();

    expect(() => world.insertComponent(entity, Position, { x: 1e300 })).toThrow(
      'schema validation'
    );
    expect(world.hasComponent(entity, Position)).toBe(false);
  });

  test('rejects ChildOf cycles without changing the existing hierarchy', () => {
    const world = new World();
    const root = world.spawn().build();
    const child = world.spawn().addRelation(ChildOf, root).build();
    const commands = new CommandBuffer();
    commands.setRelation(root, ChildOf, child);

    expect(() => commands.apply(world)).toThrow('cycle');
    expect(world.getParent(root)).toBeNull();
    expect(world.getParent(child)).toBe(root);
  });

  test('guards direct structural mutation during query iteration and allows deferred apply', () => {
    const world = new World();
    world.registerComponent(Position);
    const entity = world.spawn().insert(Position, { x: 1 }).build();
    const commands = new CommandBuffer();

    for (const [row] of world.query([Position])) {
      expect(() => world.spawn()).toThrow('query iteration');
      commands.despawn(row);
    }
    commands.apply(world, 'after-query');

    expect(world.isAlive(entity)).toBe(false);
  });

  test('validates component membership across the whole virtual command batch', () => {
    const world = new World();
    world.registerComponent(Position);
    const entity = world.spawn().build();
    const commands = new CommandBuffer();

    commands.insert(entity, Position, { x: 1 });
    commands.remove(entity, Position);
    expect(() => commands.apply(world)).not.toThrow();
    expect(world.hasComponent(entity, Position)).toBe(false);

    world.insertComponent(entity, Position, { x: 2 });
    commands.remove(entity, Position);
    commands.remove(entity, Position);
    expect(() => commands.apply(world)).toThrow('does not have component');
    expect(world.getComponent(entity, Position)?.x).toBe(2);
    commands.clear();

    const ticket = commands.spawn();
    commands.remove(ticket, Position);
    expect(() => commands.apply(world)).toThrow('does not have component');
  });

  test('App applies the shared command queue after PostUpdate', async () => {
    const visible: number[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.command-apply-point',
        build(builder) {
          builder.addSystem('Startup', {
            id: 'register-command-position',
            run(world) {
              world.registerComponent(Position);
            }
          });
          builder.addSystem('Update', {
            id: 'queue-spawn',
            run(world) {
              world.getResource(CommandBufferResource)!.spawn([
                { component: Position, data: { x: 9 } }
              ]);
            }
          });
          builder.addSystem('PostUpdate', {
            id: 'before-apply',
            run(world) {
              visible.push([...world.query([Position])].length);
            }
          });
          builder.addSystem('Last', {
            id: 'after-apply',
            run(world) {
              visible.push([...world.query([Position])].length);
            }
          });
        }
      })
    );

    await app.run(new HeadlessRunner({ frames: 1 }));

    expect(visible).toEqual([0, 1]);
  });

  test('plugins can register deterministic named apply points during schedule build', async () => {
    const visible: number[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.named-command-apply',
        build(builder) {
          builder.addSystem('Startup', {
            id: 'register-position',
            run: (world) => void world.registerComponent(Position)
          });
          builder.addSystem('Update', {
            id: 'queue-position',
            run(world) {
              world.getResource(CommandBufferResource)!.spawn([
                { component: Position, data: { x: 7 } }
              ]);
            }
          });
          builder.addCommandApplyPoint('Update', {
            id: 'editor-transaction',
            after: ['queue-position']
          });
          builder.addSystem('PostUpdate', {
            id: 'observe-named-apply',
            run: (world) => void visible.push([...world.query([Position])].length)
          });
        }
      })
    );

    await app.run(new HeadlessRunner({ frames: 1 }));

    expect(visible).toEqual([1]);
  });
});

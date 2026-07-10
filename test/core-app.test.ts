import { describe, expect, test } from 'vitest';
import {
  App,
  HeadlessRunner,
  MinimalPlugins,
  Schedule,
  Time,
  World,
  type Plugin
} from '../src';

describe('Schedule', () => {
  test('runs systems in stable before/after order', () => {
    const order: string[] = [];
    const schedule = new Schedule('Update');

    schedule.addSystem({
      id: 'render',
      after: ['simulate'],
      run: () => void order.push('render')
    });
    schedule.addSystem({
      id: 'input',
      before: ['simulate'],
      run: () => void order.push('input')
    });
    schedule.addSystem({ id: 'simulate', run: () => void order.push('simulate') });

    schedule.runSync(new World());

    expect(order).toEqual(['input', 'simulate', 'render']);
  });

  test('rejects missing required ordering targets and permits optional targets', () => {
    const schedule = new Schedule('Update');
    schedule.addSystem({ id: 'render', after: ['missing'], run: () => undefined });

    expect(() => schedule.runSync(new World())).toThrow(
      'Schedule "Update" system "render" references missing ordering target "missing".'
    );

    const optional = new Schedule('Update');
    optional.addSystem({ id: 'render', optionalAfter: ['missing'], run: () => undefined });

    expect(() => optional.runSync(new World())).not.toThrow();
  });

  test('removes a registered system and invalidates cached order', () => {
    const schedule = new Schedule('Update');
    const order: string[] = [];
    const first = schedule.addSystem({ id: 'first', run: () => void order.push('first') });
    schedule.addSystem({
      id: 'second',
      optionalAfter: ['first'],
      run: () => void order.push('second')
    });

    schedule.runSync(new World());
    expect(schedule.removeSystem(first)).toBe(true);
    expect(schedule.removeSystem(first)).toBe(false);
    schedule.runSync(new World());

    expect(order).toEqual(['first', 'second', 'second']);
  });

  test('skips systems when runIf returns false and startup schedules may await', async () => {
    const world = new World();
    const schedule = new Schedule('Startup');
    const order: string[] = [];

    schedule.addSystem({
      id: 'skip',
      runIf: () => false,
      run: () => void order.push('skip')
    });
    schedule.addSystem({
      id: 'async',
      run: async () => {
        await Promise.resolve();
        order.push('async');
      }
    });

    await schedule.run(world);

    expect(order).toEqual(['async']);
  });

  test('reports the cycle path', () => {
    const schedule = new Schedule('Update');
    schedule.addSystem({ id: 'a', after: ['b'], run: () => undefined });
    schedule.addSystem({ id: 'b', after: ['a'], run: () => undefined });

    expect(() => schedule.runSync(new World())).toThrow(
      'Schedule "Update" contains a cycle: a -> b -> a.'
    );
  });
});

describe('V2 public App surface', () => {
  test('built-in plugins use V2 ids and run through HeadlessRunner', async () => {
    const app = new App().addPlugins(new MinimalPlugins());

    const exit = await app.run(new HeadlessRunner({ frames: 1 }));

    expect(app.hasPlugin('aether.time')).toBe(true);
    expect(app.getResource(Time)?.frameCount).toBe(1);
    expect(exit.frames).toBe(1);
  });
});

function assertRemovedV1Surface(app: App, plugin: Plugin): void {
  // @ts-expect-error V2 plugins use stable ids, not display names.
  void plugin.name;
  // @ts-expect-error V2 plugins use shutdown(), not cleanup().
  void plugin.cleanup;
  // @ts-expect-error Plugin registration is deferred through addPlugin().
  app.registerPlugin(plugin);
  // @ts-expect-error Registries are reachable only through narrow App lookup methods.
  void app.services;
  // @ts-expect-error Registries are reachable only through narrow App lookup methods.
  void app.extensions;
  // @ts-expect-error Frames are available only through a private RunnerContext.
  app.runFrame();
}

void assertRemovedV1Surface;

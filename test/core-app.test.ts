import { describe, expect, test } from 'vitest';
import {
  App,
  MinimalPlugins,
  Schedule,
  Time,
  type Plugin,
  definePlugin
} from '../src';

class Counter {
  value = 0;
}

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

    schedule.runSync(new App().getWorld());

    expect(order).toEqual(['input', 'simulate', 'render']);
  });

  test('rejects missing required ordering targets and permits optional targets', () => {
    const schedule = new Schedule('Update');
    schedule.addSystem({ id: 'render', after: ['missing'], run: () => undefined });

    expect(() => schedule.runSync(new App().getWorld())).toThrow(
      'Schedule "Update" system "render" references missing ordering target "missing".'
    );

    const optional = new Schedule('Update');
    optional.addSystem({ id: 'render', optionalAfter: ['missing'], run: () => undefined });

    expect(() => optional.runSync(new App().getWorld())).not.toThrow();
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

    schedule.runSync(new App().getWorld());
    expect(schedule.removeSystem(first)).toBe(true);
    expect(schedule.removeSystem(first)).toBe(false);
    schedule.runSync(new App().getWorld());

    expect(order).toEqual(['first', 'second', 'second']);
  });

  test('skips systems when runIf returns false and startup schedules may await', async () => {
    const world = new App().getWorld();
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

    expect(() => schedule.runSync(new App().getWorld())).toThrow(
      'Schedule "Update" contains a cycle: a -> b -> a.'
    );
  });
});

describe('App and plugins', () => {
  test('runs startup schedules once and frame schedules on demand', async () => {
    const app = new App();
    const order: string[] = [];

    app.addSystem('Startup', () => void order.push('startup'));
    app.addSystem('Update', () => void order.push('update'));
    app.addSystem('Render', () => void order.push('render'));

    await app.startup();
    await app.startup();
    app.runFrame();

    expect(order).toEqual(['startup', 'update', 'render']);
  });

  test('rejects async systems in frame schedules while keeping startup async-capable', async () => {
    const app = new App();
    const order: string[] = [];

    app.addSystem('Startup', async () => {
      await Promise.resolve();
      order.push('startup');
    });
    app.addSystem('Update', async () => {
      await Promise.resolve();
      order.push('update');
    });

    await app.startup();

    expect(order).toEqual(['startup']);
    expect(() => app.runFrame()).toThrow(
      'Async system "system_0" cannot run in frame schedule "Update".'
    );
  });

  test('stops the main loop when a frame system throws', async () => {
    const app = new App();
    const originalRequestFrame = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;

    app.addSystem('Update', () => {
      throw new Error('boom');
    });

    try {
      await app.run();
      expect(() => frames[0]?.(0)).toThrow('boom');
      await app.run();
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
    }
  });

  test('adds plugins once and enforces dependency order', () => {
    const events: string[] = [];
    const core = definePlugin({ name: 'Core', build: () => events.push('core') });
    const renderer = definePlugin({
      name: 'Renderer',
      dependencies: ['Core'],
      build: () => events.push('renderer')
    });

    const app = new App().addPlugin(core).addPlugin(core).addPlugin(renderer);

    expect(events).toEqual(['core', 'renderer']);
    expect(app.hasPlugin('Core')).toBe(true);
    expect(() => new App().addPlugin(renderer)).toThrow(
      'Plugin "Renderer" requires "Core" to be registered.'
    );
  });

  test('builds registered plugins later in dependency order', () => {
    const events: string[] = [];
    const core = definePlugin({ name: 'Core', build: () => events.push('core') });
    const renderer = definePlugin({
      name: 'Renderer',
      dependencies: ['Core'],
      build: () => events.push('renderer')
    });

    const app = new App().registerPlugins([renderer, core]);

    expect(events).toEqual([]);

    app.buildPlugins();

    expect(events).toEqual(['core', 'renderer']);
    expect(app.hasPlugin('Renderer')).toBe(true);
  });

  test('topologically sorts addPlugins while keeping addPlugin immediate', () => {
    const events: string[] = [];
    const core = definePlugin({ name: 'Core', build: () => events.push('core') });
    const renderer = definePlugin({
      name: 'Renderer',
      dependencies: ['Core'],
      build: () => events.push('renderer')
    });

    new App().addPlugins([renderer, core]);

    expect(events).toEqual(['core', 'renderer']);
  });

  test('rejects circular plugin dependencies during batch builds', () => {
    const plugins: Plugin[] = [
      definePlugin({ name: 'A', dependencies: ['B'], build: () => undefined }),
      definePlugin({ name: 'B', dependencies: ['A'], build: () => undefined })
    ];

    expect(() => new App().registerPlugins(plugins).buildPlugins()).toThrow(
      'Circular plugin dependency detected.'
    );
  });

  test('destroys plugins in reverse build order', () => {
    const events: string[] = [];
    const core = definePlugin({
      name: 'Core',
      build: () => events.push('build core'),
      cleanup: () => events.push('cleanup core')
    });
    const renderer = definePlugin({
      name: 'Renderer',
      dependencies: ['Core'],
      build: () => events.push('build renderer'),
      cleanup: () => events.push('cleanup renderer')
    });

    new App().addPlugins([renderer, core]).destroy();

    expect(events).toEqual([
      'build core',
      'build renderer',
      'cleanup renderer',
      'cleanup core'
    ]);
  });

  test('stores resources by constructor type', () => {
    const app = new App();
    const counter = new Counter();

    app.insertResource(counter);

    expect(app.getResource(Counter)).toBe(counter);
    expect(app.getWorld().hasResource(Counter)).toBe(true);
  });

  test('minimal plugins install time resource and update it during First', async () => {
    const app = new App().addPlugins(new MinimalPlugins());
    const time = app.getResource(Time);

    expect(time).toBeInstanceOf(Time);

    app.runFrame();

    expect(time?.frameCount).toBe(1);
    expect(time?.elapsed).toBeGreaterThanOrEqual(0);
  });
});

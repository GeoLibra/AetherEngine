import { describe, expect, test } from 'vitest';
import {
  App,
  MinimalPlugins,
  Schedule,
  Time,
  type Plugin,
  createExtensionPoint,
  createServiceToken,
  definePlugin
} from '../src';

class Counter {
  value = 0;
}

describe('Schedule', () => {
  test('runs systems in before/after order and caches that order until changed', async () => {
    const order: string[] = [];
    const schedule = new Schedule('Update');

    schedule
      .addSystem({ name: 'render', after: ['simulate'], system: () => void order.push('render') })
      .addSystem({ name: 'input', before: ['simulate'], system: () => void order.push('input') })
      .addSystem({ name: 'simulate', system: () => void order.push('simulate') });

    await schedule.run(new App().getWorld());

    expect(order).toEqual(['input', 'simulate', 'render']);
  });

  test('skips systems when runIf returns false and supports async systems', async () => {
    const world = new App().getWorld();
    const schedule = new Schedule('Update');
    const order: string[] = [];

    schedule
      .addSystem({ name: 'skip', runIf: () => false, system: () => void order.push('skip') })
      .addSystem(async () => {
        await Promise.resolve();
        order.push('async');
      });

    await schedule.run(world);

    expect(order).toEqual(['async']);
  });

  test('allows function systems with repeated minified names when no explicit label is provided', async () => {
    const world = new App().getWorld();
    const schedule = new Schedule('Update');
    const order: string[] = [];
    const update = () => void order.push('first');
    const anotherUpdate = Object.defineProperty(() => void order.push('second'), 'name', {
      value: 'update'
    });

    schedule.addSystem(update).addSystem(anotherUpdate);

    await schedule.run(world);

    expect(order).toEqual(['first', 'second']);
  });

  test('throws when schedule dependencies contain a cycle', async () => {
    const schedule = new Schedule('Update');
    schedule
      .addSystem({ name: 'a', after: ['b'], system: () => undefined })
      .addSystem({ name: 'b', after: ['a'], system: () => undefined });

    await expect(schedule.run(new App().getWorld())).rejects.toThrow(
      'Circular dependency detected in schedule "Update"'
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

  test('destroy clears services and extension contributions for app reuse', () => {
    const RendererToken = createServiceToken<{ name: string }>('renderer.destroy');
    const PanelExtension = createExtensionPoint<{ id: string }>('editor.panel.destroy');
    const plugin = definePlugin({
      name: 'RegistryPlugin',
      build(app) {
        app.services.provide(RendererToken, { name: 'renderer' });
        app.extensions.add(PanelExtension, { id: 'inspector' });
      }
    });

    const app = new App().addPlugin(plugin);

    expect(app.services.has(RendererToken)).toBe(true);
    expect(app.extensions.list(PanelExtension)).toHaveLength(1);

    app.destroy();

    expect(app.services.has(RendererToken)).toBe(false);
    expect(app.extensions.list(PanelExtension)).toEqual([]);
    expect(() => app.addPlugin(plugin)).not.toThrow();
    expect(app.services.has(RendererToken)).toBe(true);
  });

  test('stores resources by constructor type', () => {
    const app = new App();
    const counter = new Counter();

    app.insertResource(counter);

    expect(app.getResource(Counter)).toBe(counter);
    expect(app.getWorld().hasResource(Counter)).toBe(true);
  });

  test('provides typed services with scoped lookup and global fallback', () => {
    const RendererToken = createServiceToken<{ name: string }>('renderer');
    const app = new App();

    app.services.provide(RendererToken, { name: 'shared' }, { scope: 'global' });
    app.services.provide(RendererToken, { name: 'main' }, { scope: 'main' });

    expect(app.services.get(RendererToken).name).toBe('main');
    expect(app.services.get(RendererToken, 'render').name).toBe('shared');
    expect(app.services.has(RendererToken, 'editor')).toBe(true);
  });

  test('supports singleton, transient, and frame scoped service providers', () => {
    const SingletonToken = createServiceToken<{ id: number }>('singleton');
    const TransientToken = createServiceToken<{ id: number }>('transient');
    const FrameToken = createServiceToken<{ id: number }>('frame');
    const app = new App();
    let nextId = 0;

    app.services.provide(SingletonToken, () => ({ id: ++nextId }));
    app.services.provide(TransientToken, () => ({ id: ++nextId }), { lifecycle: 'transient' });
    app.services.provide(FrameToken, () => ({ id: ++nextId }), { lifecycle: 'frame' });

    expect(app.services.get(SingletonToken)).toBe(app.services.get(SingletonToken));
    expect(app.services.get(TransientToken)).not.toBe(app.services.get(TransientToken));

    const frameService = app.services.get(FrameToken);
    expect(app.services.get(FrameToken)).toBe(frameService);

    app.services.clearFrameScoped();

    expect(app.services.get(FrameToken)).not.toBe(frameService);
  });

  test('collects extension contributions in registration order', () => {
    const AssetImporter = createExtensionPoint<{ extension: string }>('asset.importer');
    const app = new App();

    app.extensions.add(AssetImporter, { extension: 'gltf' });
    app.extensions.add(AssetImporter, { extension: 'ktx2' });

    expect(app.extensions.list(AssetImporter)).toEqual([
      { extension: 'gltf' },
      { extension: 'ktx2' }
    ]);
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

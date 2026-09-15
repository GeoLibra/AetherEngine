import { describe, expect, test } from 'vitest';
import {
  App,
  SchemaRegistryResource,
  createExtensionPoint,
  createServiceToken,
  definePlugin,
  defineResource,
  defineSchema,
  serviceValue,
  type World
} from '../../src';

describe('App plugin preflight and transactions', () => {
  test('preflights the entire graph before any plugin build', async () => {
    const events: string[] = [];
    const valid = definePlugin({ id: 'valid', build: () => void events.push('build') });
    const missing = definePlugin({
      id: 'missing',
      dependencies: ['absent'],
      build: () => undefined
    });
    const app = new App().addPlugins([valid, missing]);

    await expect(app.startup()).rejects.toThrow('missing -> absent');
    expect(events).toEqual([]);
  });

  test('rejects duplicate ids and reports plugin dependency cycles before build', async () => {
    const events: string[] = [];
    const duplicate = () =>
      definePlugin({ id: 'duplicate', build: () => void events.push('build') });
    const duplicateApp = new App().addPlugins([duplicate(), duplicate()]);

    await expect(duplicateApp.startup()).rejects.toThrow('duplicate plugin id "duplicate"');
    expect(events).toEqual([]);

    const cycleApp = new App().addPlugins([
      definePlugin({ id: 'a', dependencies: ['b'], build: () => undefined }),
      definePlugin({ id: 'b', dependencies: ['a'], build: () => undefined })
    ]);
    await expect(cycleApp.startup()).rejects.toThrow('a -> b -> a');
  });

  test('rolls back every contribution from a failing build including deferCleanup', async () => {
    class Counter {}
    const CounterResource = defineResource<Counter>('test.rollback-counter');
    const Token = createServiceToken<object>('rollback.service');
    const Point = createExtensionPoint<string>('rollback.extension');
    const cleanups: string[] = [];

    const schemaV1 = defineSchema<Record<string, unknown>>({
      id: 'test.rollback-schema',
      version: 1,
      kind: 'document',
      fields: [],
      validate: (input) => ({ ok: true, value: input as Record<string, unknown> })
    });
    const schemaV2 = defineSchema<Record<string, unknown>>({
      id: 'test.rollback-schema',
      version: 2,
      kind: 'document',
      fields: [],
      validate: (input) => ({ ok: true, value: input as Record<string, unknown> })
    });
    const app = new App().addPlugin(
      definePlugin({
        id: 'failing',
        build(builder) {
          builder.insertResource(CounterResource, new Counter());
          builder.deferCleanup(() => cleanups.push('cleanup 1'));
          builder.addSystem('Update', {
            id: 'failing.system',
            reads: [CounterResource],
            writes: [CounterResource],
            run: () => undefined
          });
          builder.provideService(Token, serviceValue({}));
          builder.addExtension(Point, { id: 'failing.extension', value: 'value' });
          builder.registerSchema(schemaV1);
          builder.registerSchema(schemaV2);
          builder.registerSchemaMigration({
            schema: 'test.rollback-schema',
            from: 1,
            to: 2,
            migrate: (input) => ({ value: input })
          });
          builder.deferCleanup(() => cleanups.push('cleanup 2'));
          throw new Error('build failed');
        }
      })
    );

    await expect(app.startup()).rejects.toThrow('build failed');
    expect(app.state).toBe('failed');
    expect(cleanups).toEqual(['cleanup 2', 'cleanup 1']);
    expect(app.getResource(CounterResource)).toBeUndefined();
    expect(() => app.getService(Token)).toThrow('not registered');
    expect(app.listExtensions(Point)).toEqual([]);
    expect(app.getResource(SchemaRegistryResource)?.get('test.rollback-schema', 1)).toBeUndefined();
    expect(app.getResource(SchemaRegistryResource)?.get('test.rollback-schema', 2)).toBeUndefined();
  });

  test('defensively copies descriptor arrays preventing caller mutation from corrupting graph', async () => {
    const mutableBefore: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'defensive-arrays',
        build(builder) {
          builder.addSystem('Update', {
            id: 'system-a',
            before: mutableBefore,
            run: () => undefined
          });
          mutableBefore.push('non-existent-target');
        }
      })
    );

    await expect(app.startup()).resolves.toBeUndefined();
  });

  test('eager schedule compile barrier fails startup on invalid schedule before PreStartup runs', async () => {
    let preStartupRan = false;
    const app = new App().addPlugin(
      definePlugin({
        id: 'invalid-schedule-plugin',
        build(builder) {
          builder.addSystem('PreStartup', {
            id: 'pre-startup-system',
            run: () => {
              preStartupRan = true;
            }
          });
          // Update schedule has an invalid missing target
          builder.addSystem('Update', {
            id: 'broken-update-system',
            before: ['ghost-target'],
            run: () => undefined
          });
        }
      })
    );

    await expect(app.startup()).rejects.toThrow('ghost-target');
    expect(preStartupRan).toBe(false);
    expect(app.state).toBe('failed');
  });
});

describe('App lifecycle', () => {
  test('rejects startup and plugin installation as soon as destroy begins', async () => {
    const app = new App();
    const destroying = app.destroy();

    expect(() => app.addPlugin(definePlugin({ id: 'too-late', build: () => undefined }))).toThrow(
      'being destroyed'
    );
    await expect(app.startup()).rejects.toThrow('being destroyed');
    await destroying;
  });

  test('starts and destroys its owned World with the App lifecycle', async () => {
    let mainWorld: World | undefined;
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.world-lifecycle',
        build(builder) {
          builder.addSystem('PreStartup', {
            id: 'test.capture-world-lifecycle',
            run(world) {
              mainWorld = world;
              expect(world.state).toBe('running');
            }
          });
        }
      })
    );

    await app.startup();
    expect(mainWorld?.state).toBe('running');

    await app.destroy();
    expect(mainWorld?.state).toBe('destroyed');
  });

  test('runs build, prepare, and finish in dependency order and shutdown in reverse', async () => {
    const events: string[] = [];
    const makePlugin = (id: string, dependencies: readonly string[] = []) =>
      definePlugin({
        id,
        dependencies,
        build: () => void events.push(`build ${id}`),
        prepare: () => {
          events.push(`prepare ${id}`);
        },
        finish: () => void events.push(`finish ${id}`),
        shutdown: () => void events.push(`shutdown ${id}`)
      });
    const app = new App().addPlugins([makePlugin('renderer', ['core']), makePlugin('core')]);

    await app.startup();
    await app.destroy();

    expect(events).toEqual([
      'build core',
      'build renderer',
      'prepare core',
      'prepare renderer',
      'finish core',
      'finish renderer',
      'shutdown renderer',
      'shutdown core'
    ]);
    expect(app.state).toBe('destroyed');
  });

  test('rolls back a rejected finish and shuts down every built plugin', async () => {
    class FinishedResource {}
    const FinishedResourceToken = defineResource<FinishedResource>('test.finished-resource');
    const events: string[] = [];
    const app = new App().addPlugins([
      definePlugin({
        id: 'core',
        build: () => undefined,
        shutdown: () => void events.push('shutdown core')
      }),
      definePlugin({
        id: 'feature',
        dependencies: ['core'],
        build: () => undefined,
        finish(builder) {
          builder.insertResource(FinishedResourceToken, new FinishedResource());
          throw new Error('finish failed');
        },
        shutdown: () => void events.push('shutdown feature')
      })
    ]);

    await expect(app.startup()).rejects.toThrow('finish failed');

    expect(app.getResource(FinishedResourceToken)).toBeUndefined();
    expect(events).toEqual(['shutdown feature', 'shutdown core']);
    expect(app.state).toBe('failed');
  });

  test('rejects asynchronous build and finish hooks', async () => {
    const asyncBuild = new App().addPlugin(
      definePlugin({
        id: 'async-build',
        build: (() => Promise.resolve()) as unknown as () => void
      })
    );
    await expect(asyncBuild.startup()).rejects.toThrow('build() must be synchronous');

    const asyncFinish = new App().addPlugin(
      definePlugin({
        id: 'async-finish',
        build: () => undefined,
        finish: (() => Promise.resolve()) as unknown as () => void
      })
    );
    await expect(asyncFinish.startup()).rejects.toThrow('finish() must be synchronous');
  });

  test('cooperatively cancels async prepare on destroy during startup', async () => {
    let prepareSignal: AbortSignal | undefined;
    let settled = false;

    const app = new App().addPlugin(
      definePlugin({
        id: 'cancellable-plugin',
        build: () => undefined,
        async prepare(context) {
          prepareSignal = context.signal;
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => {
              settled = true;
              resolve();
            });
          });
        }
      })
    );

    const startupPromise = app.startup();
    // Yield to let prepare start
    await new Promise((r) => setTimeout(r, 10));

    expect(prepareSignal?.aborted).toBe(false);

    // Call destroy while prepare is awaiting
    const destroyPromise = app.destroy();
    expect(prepareSignal?.aborted).toBe(true);

    await expect(startupPromise).rejects.toThrow();
    const result = await destroyPromise;
    expect(settled).toBe(true);
    expect(app.state).toBe('destroyed');
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  test('runs committed deferCleanup callbacks on destroy in reverse order', async () => {
    const cleanups: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'cleanup-test',
        build(builder) {
          builder.deferCleanup(() => cleanups.push('first'));
          builder.deferCleanup(() => cleanups.push('second'));
        }
      })
    );

    await app.startup();
    await app.destroy();

    expect(cleanups).toEqual(['second', 'first']);
  });

  test('aggregates shutdown failures and destroy is idempotent', async () => {
    const app = new App().addPlugins([
      definePlugin({
        id: 'first',
        build: () => undefined,
        shutdown: () => {
          throw new Error('first shutdown failed');
        }
      }),
      definePlugin({
        id: 'second',
        build: () => undefined,
        shutdown: async () => {
          await Promise.resolve();
          throw new Error('second shutdown failed');
        }
      })
    ]);
    await app.startup();

    const firstPromise = app.destroy();
    const secondPromise = app.destroy();
    expect(secondPromise).toBe(firstPromise);
    const first = await firstPromise;
    const second = await app.destroy();

    expect(second).toBe(first);
    expect(first.diagnostics).toHaveLength(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });

  test('rejects late plugin installation and cannot restart a stopped app', async () => {
    const plugin = definePlugin({ id: 'late', build: () => undefined });
    const app = new App();
    await app.startup();

    expect(() => app.addPlugin(plugin)).toThrow('state "running"');
    app.stop('test');
    expect(app.state).toBe('stopped');
    await expect(app.startup()).rejects.toThrow('state "stopped"');
  });
});

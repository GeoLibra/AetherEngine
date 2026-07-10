import { describe, expect, test } from 'vitest';
import {
  App,
  createExtensionPoint,
  createServiceToken,
  definePlugin,
  serviceValue
} from '../src';

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
    const duplicate = () => definePlugin({ id: 'duplicate', build: () => void events.push('build') });
    const duplicateApp = new App().addPlugins([duplicate(), duplicate()]);

    await expect(duplicateApp.startup()).rejects.toThrow('duplicate plugin id "duplicate"');
    expect(events).toEqual([]);

    const cycleApp = new App().addPlugins([
      definePlugin({ id: 'a', dependencies: ['b'], build: () => undefined }),
      definePlugin({ id: 'b', dependencies: ['a'], build: () => undefined })
    ]);
    await expect(cycleApp.startup()).rejects.toThrow('a -> b -> a');
  });

  test('rolls back every contribution from a failing build', async () => {
    class Counter {}
    const Token = createServiceToken<object>('rollback.service');
    const Point = createExtensionPoint<string>('rollback.extension');
    const app = new App().addPlugin(
      definePlugin({
        id: 'failing',
        build(builder) {
          builder.insertResource(new Counter());
          builder.addSystem('Update', { id: 'failing.system', run: () => undefined });
          builder.provideService(Token, serviceValue({}));
          builder.addExtension(Point, { id: 'failing.extension', value: 'value' });
          throw new Error('build failed');
        }
      })
    );

    await expect(app.startup()).rejects.toThrow('build failed');
    expect(app.state).toBe('failed');
    expect(app.getResource(Counter)).toBeUndefined();
    expect(() => app.getService(Token)).toThrow('not registered');
    expect(app.listExtensions(Point)).toEqual([]);
  });
});

describe('App lifecycle', () => {
  test('runs build, ready, and finish in dependency order and shutdown in reverse', async () => {
    const events: string[] = [];
    const makePlugin = (id: string, dependencies: readonly string[] = []) =>
      definePlugin({
        id,
        dependencies,
        build: () => void events.push(`build ${id}`),
        ready: () => {
          events.push(`ready ${id}`);
          return true;
        },
        finish: () => void events.push(`finish ${id}`),
        shutdown: () => void events.push(`shutdown ${id}`)
      });
    const app = new App().addPlugins([
      makePlugin('renderer', ['core']),
      makePlugin('core')
    ]);

    await app.startup();
    await app.destroy();

    expect(events).toEqual([
      'build core',
      'build renderer',
      'ready core',
      'ready renderer',
      'finish core',
      'finish renderer',
      'shutdown renderer',
      'shutdown core'
    ]);
    expect(app.state).toBe('destroyed');
  });

  test('rolls back a rejected finish and shuts down every built plugin', async () => {
    class FinishedResource {}
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
        async finish(builder) {
          builder.insertResource(new FinishedResource());
          await Promise.resolve();
          throw new Error('finish failed');
        },
        shutdown: () => void events.push('shutdown feature')
      })
    ]);

    await expect(app.startup()).rejects.toThrow('finish failed');

    expect(app.getResource(FinishedResource)).toBeUndefined();
    expect(events).toEqual(['shutdown feature', 'shutdown core']);
    expect(app.state).toBe('failed');
  });

  test('closes structural mutation as soon as finish returns', async () => {
    class LateResource {}
    let lateError: unknown;
    const app = new App().addPlugin(
      definePlugin({
        id: 'late-finish-mutation',
        build: () => undefined,
        async finish(builder) {
          await Promise.resolve();
          try {
            builder.insertResource(new LateResource());
          } catch (error) {
            lateError = error;
          }
        }
      })
    );

    await app.startup();

    expect(lateError).toBeInstanceOf(Error);
    expect((lateError as Error).message).toContain('is closed');
    expect(app.getResource(LateResource)).toBeUndefined();
  });

  test('treats false readiness as failure and rejects asynchronous build hooks', async () => {
    const notReady = new App().addPlugin(
      definePlugin({ id: 'not-ready', build: () => undefined, ready: () => false })
    );
    await expect(notReady.startup()).rejects.toThrow('reported that it is not ready');

    const asyncBuild = new App().addPlugin(
      definePlugin({
        id: 'async-build',
        build: (() => Promise.resolve()) as unknown as () => void
      })
    );
    await expect(asyncBuild.startup()).rejects.toThrow('build() must be synchronous');
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

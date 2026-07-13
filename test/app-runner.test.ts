import { describe, expect, test } from 'vitest';
import {
  App,
  BrowserRunner,
  FrameTime,
  HeadlessRunner,
  createTimePlugin,
  createServiceToken,
  definePlugin,
  serviceFactory,
  type AnimationFrameHost
} from '../src';

describe('App runners', () => {
  test('HeadlessRunner executes a finite number of identical App frames', async () => {
    let frames = 0;
    const app = new App().addPlugin(
      definePlugin({
        id: 'frame-counter',
        build(builder) {
          builder.addSystem('Update', {
            id: 'count-frame',
            run: () => void frames++
          });
        }
      })
    );

    const exit = await app.run(new HeadlessRunner({ frames: 3 }));

    expect(frames).toBe(3);
    expect(exit).toEqual({ reason: 'completed', frames: 3 });
    expect(app.state).toBe('stopped');
  });

  test('frame cleanup runs after a system throws and preserves the primary error', async () => {
    const Frame = createServiceToken<object>('frame');
    const events: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'frame.failure',
        build(builder) {
          builder.provideService(
            Frame,
            serviceFactory(() => ({}), {
              lifecycle: 'frame',
              dispose: () => {
                events.push('disposed');
                throw new Error('cleanup failed');
              }
            })
          );
          builder.addSystem('Update', {
            id: 'throw',
            run: () => {
              throw new Error('boom');
            }
          });
        }
      })
    );
    await app.startup();
    app.getService(Frame);

    await expect(app.run(new HeadlessRunner({ frames: 1 }))).rejects.toThrow('boom');

    expect(events).toEqual(['disposed']);
    expect(app.state).toBe('failed');
    const destroyed = await app.destroy();
    expect(destroyed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'FRAME_CLEANUP_FAILED',
      'APP_RUNTIME_FAILED'
    ]);
  });

  test('runs the explicit FrameCleanup schedule even after a frame system fails', async () => {
    const events: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'frame-cleanup-schedule',
        build(builder) {
          builder.addSystem('Update', {
            id: 'fail-update',
            run() {
              events.push('update');
              throw new Error('frame failed');
            }
          });
          builder.addSystem('FrameCleanup', {
            id: 'always-cleanup',
            run: () => void events.push('cleanup')
          });
        }
      })
    );

    await expect(app.run(new HeadlessRunner({ frames: 1 }))).rejects.toThrow(
      'frame failed'
    );
    expect(events).toEqual(['update', 'cleanup']);
  });

  test('BrowserRunner uses only the injected animation frame host', async () => {
    const callbacks = new Map<number, (timestamp: number) => void>();
    const cancelled: number[] = [];
    let nextId = 0;
    const host: AnimationFrameHost = {
      request(callback) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        cancelled.push(id);
        callbacks.delete(id);
      }
    };
    const app = new App();
    const running = app.run(new BrowserRunner(host));
    for (let attempt = 0; attempt < 8 && !callbacks.has(1); attempt++) {
      await Promise.resolve();
    }
    callbacks.get(1)?.(0);
    app.stop('test');

    const exit = await running;

    expect(exit).toEqual({ reason: 'test', frames: 1 });
    expect(cancelled).toContain(2);
    expect(app.state).toBe('stopped');
  });

  test('BrowserRunner completes the current frame before honoring an in-frame stop', async () => {
    const callbacks = new Map<number, (timestamp: number) => void>();
    let nextId = 0;
    const host: AnimationFrameHost = {
      request(callback) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        callbacks.delete(id);
      }
    };
    const app = new App().addPlugin(
      definePlugin({
        id: 'stop-inside-frame',
        build(builder) {
          builder.addSystem('Update', {
            id: 'request-stop',
            run: () => app.stop('inside-frame')
          });
        }
      })
    );
    const running = app.run(new BrowserRunner(host));
    for (let attempt = 0; attempt < 8 && !callbacks.has(1); attempt++) {
      await Promise.resolve();
    }

    callbacks.get(1)?.(0);
    const exit = await running;

    expect(exit).toEqual({ reason: 'inside-frame', frames: 1 });
    expect(callbacks.has(2)).toBe(false);
  });

  test('BrowserRunner forwards animation timestamps to FrameTime in seconds', async () => {
    const callbacks = new Map<number, (timestamp: number) => void>();
    let nextId = 0;
    const host: AnimationFrameHost = {
      request(callback) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        callbacks.delete(id);
      }
    };
    const app = new App().addPlugin(createTimePlugin());
    const running = app.run(new BrowserRunner(host));
    for (let attempt = 0; attempt < 8 && !callbacks.has(1); attempt++) {
      await Promise.resolve();
    }

    callbacks.get(1)?.(1000);
    callbacks.get(2)?.(1016);
    app.stop('test');
    await running;

    expect(app.getResource(FrameTime)?.frame).toBe(2);
    expect(app.getResource(FrameTime)?.rawDelta).toBeCloseTo(0.016);
  });

  test('rejects concurrent runners', async () => {
    let release: (() => void) | undefined;
    const blockingRunner = {
      run: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { reason: 'released', frames: 0 };
      },
      requestStop: () => undefined
    };
    const app = new App();
    const first = app.run(blockingRunner);

    await expect(app.run(new HeadlessRunner({ frames: 1 }))).rejects.toThrow(
      'Runner is already active'
    );
    release?.();
    await first;
  });
});

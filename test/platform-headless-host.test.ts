import { describe, expect, test } from 'vitest';
import { App, HeadlessHost, ManualClock, definePlugin } from '../src';

describe('HeadlessHost', () => {
  test('owns independent windows in deterministic registration order', async () => {
    const host = new HeadlessHost();
    expect(host.windows()).toEqual([]);
    expect(Object.isFrozen(host.windows())).toBe(true);

    const first = await host.createWindow({ logicalSize: [320, 200] });
    const second = await host.createWindow({ logicalSize: [640, 480] });

    expect(host.windows().map((window) => window.id)).toEqual([first.id, second.id]);
    expect(first.id).not.toBe(second.id);
    first.close();
    expect(second.state).toBe('open');
  });

  test('commits every pending window snapshot immediately before an App frame', async () => {
    const host = new HeadlessHost({ startTime: 10 });
    const window = await host.createWindow({ logicalSize: [320, 200] });
    const observedSizes: (readonly [number, number])[] = [];
    window.queueMetrics({ logicalSize: [800, 450] });
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.headless-host-frame-boundary',
        build(builder) {
          builder.addSystem('Update', {
            id: 'observe-window-metrics',
            run: () => void observedSizes.push(window.metrics.logicalSize)
          });
        }
      })
    );

    const exit = await app.run(
      host.createRunner({ kind: 'headless', frames: 2, frameDelta: 0.5 })
    );

    expect(exit).toEqual({ reason: 'completed', frames: 2 });
    expect(observedSizes).toEqual([
      [800, 450],
      [800, 450]
    ]);
    expect(window.generation).toBe(1);
    expect(host.clock.now()).toBe(10.5);
  });

  test('destroys every owned window and rejects later platform creation', async () => {
    const host = new HeadlessHost();
    const first = await host.createWindow({ logicalSize: [320, 200] });
    const second = await host.createWindow({ logicalSize: [640, 480] });

    host.destroy();
    host.destroy();

    expect(host.state).toBe('destroyed');
    expect(first.state).toBe('closed');
    expect(second.state).toBe('closed');
    await expect(host.createWindow({ logicalSize: [1, 1] })).rejects.toThrow(
      'Cannot create a window on a destroyed HeadlessHost.'
    );
    expect(() => host.createRunner({ kind: 'headless', frames: 1 })).toThrow(
      'Cannot create a runner on a destroyed HeadlessHost.'
    );
  });
});

describe('ManualClock', () => {
  test('advances deterministically and rejects invalid or reversed time', () => {
    const clock = new ManualClock(2);
    clock.set(3.5);
    expect(clock.now()).toBe(3.5);
    expect(() => clock.set(3)).toThrow('ManualClock cannot move backwards.');
    expect(() => clock.set(Number.NaN)).toThrow('ManualClock time must be finite.');
  });
});

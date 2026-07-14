import { describe, expect, test } from 'vitest';
import {
  App,
  BrowserHost,
  type AnimationFrameHost,
  type BrowserPlatformPort,
  type BrowserWindowPort,
  type MonotonicClock,
  type SurfaceTarget,
  type WindowId,
  type WindowMetricsUpdate,
  type WindowOptions
} from '../src';

class TestAnimationFrames implements AnimationFrameHost {
  private nextId = 1;
  private readonly callbacks = new Map<number, (timestamp: number) => void>();

  request(callback: (timestamp: number) => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(id: number): void {
    this.callbacks.delete(id);
  }

  hasPendingFrame(): boolean {
    return this.callbacks.size > 0;
  }

  fire(timestampMilliseconds: number): boolean {
    const entry = this.callbacks.entries().next().value as
      | [number, (timestamp: number) => void]
      | undefined;
    if (entry === undefined) {
      return false;
    }
    this.callbacks.delete(entry[0]);
    entry[1](timestampMilliseconds);
    return true;
  }
}

class TestBrowserWindowPort implements BrowserWindowPort {
  readonly surfaceTarget: SurfaceTarget;
  closeRequests = 0;
  private metricsListener: ((update: WindowMetricsUpdate) => void) | undefined;
  private closeListener: (() => void) | undefined;

  constructor(readonly id: WindowId) {
    this.surfaceTarget = Object.freeze({
      id: Symbol(`surface-${id}`),
      kind: 'canvas' as const
    });
  }

  onMetrics(listener: (update: WindowMetricsUpdate) => void): () => void {
    this.metricsListener = listener;
    return () => {
      this.metricsListener = undefined;
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => {
      this.closeListener = undefined;
    };
  }

  close(): void {
    this.closeRequests++;
  }

  emitMetrics(update: WindowMetricsUpdate): void {
    this.metricsListener?.(update);
  }

  emitClose(): void {
    this.closeListener?.();
  }
}

class TestBrowserPlatformPort implements BrowserPlatformPort {
  readonly clock: MonotonicClock = { now: () => 42 };
  readonly animationFrames = new TestAnimationFrames();
  private readonly windowPorts = new Map<WindowId, TestBrowserWindowPort>();

  createWindow(id: WindowId, _options: WindowOptions): BrowserWindowPort {
    const port = new TestBrowserWindowPort(id);
    this.windowPorts.set(id, port);
    return port;
  }

  window(id: WindowId): TestBrowserWindowPort {
    const port = this.windowPorts.get(id);
    if (port === undefined) {
      throw new Error(`Missing test window port ${id}.`);
    }
    return port;
  }
}

describe('BrowserHost', () => {
  test('publishes injected resize metrics only at the browser runner frame boundary', async () => {
    const port = new TestBrowserPlatformPort();
    const host = new BrowserHost(port);
    const window = await host.createWindow({ logicalSize: [640, 360] });
    port.window(window.id).emitMetrics({ logicalSize: [800, 450] });
    port.window(window.id).emitMetrics({ devicePixelRatio: 2 });
    expect(window.metrics.logicalSize).toEqual([640, 360]);

    const app = new App();
    const running = app.run(host.createRunner({ kind: 'browser' }));
    await waitForAnimationFrame(port.animationFrames);
    expect(port.animationFrames.fire(1_000)).toBe(true);

    expect(window.metrics.physicalSize).toEqual([1600, 900]);
    expect(window.generation).toBe(1);
    expect(window.surfaceTarget).toBe(port.window(window.id).surfaceTarget);
    expect(host.clock.now()).toBe(42);
    app.stop('test');
    await expect(running).resolves.toEqual({ reason: 'test', frames: 1 });
  });

  test('coalesces visibility and focus while zero extent remains non-renderable', async () => {
    const port = new TestBrowserPlatformPort();
    const host = new BrowserHost(port);
    const window = await host.createWindow({ logicalSize: [640, 360] });
    const nativeWindow = port.window(window.id);

    nativeWindow.emitMetrics({ visible: false, focused: false });
    window.commitFrameBoundary();
    expect(window.metrics.visible).toBe(false);
    expect(window.renderable).toBe(false);

    nativeWindow.emitMetrics({ visible: true, logicalSize: [0, 0] });
    window.commitFrameBoundary();
    expect(window.metrics.visible).toBe(true);
    expect(window.metrics.physicalSize).toEqual([0, 0]);
    expect(window.renderable).toBe(false);
  });

  test('keeps window close paths independent and releases port subscriptions', async () => {
    const port = new TestBrowserPlatformPort();
    const host = new BrowserHost(port);
    const first = await host.createWindow({ logicalSize: [320, 200] });
    const second = await host.createWindow({ logicalSize: [640, 480] });
    const firstPort = port.window(first.id);
    const secondPort = port.window(second.id);

    firstPort.emitClose();

    expect(first.state).toBe('closed');
    expect(firstPort.closeRequests).toBe(0);
    expect(second.state).toBe('open');
    second.close();
    expect(secondPort.closeRequests).toBe(1);
    secondPort.emitMetrics({ logicalSize: [999, 999] });
    expect(second.commitFrameBoundary()).toBe(false);
  });

  test('destroys all windows and rejects later creation', async () => {
    const port = new TestBrowserPlatformPort();
    const host = new BrowserHost(port);
    const window = await host.createWindow({ logicalSize: [320, 200] });

    host.destroy();

    expect(host.state).toBe('destroyed');
    expect(window.state).toBe('closed');
    expect(port.window(window.id).closeRequests).toBe(1);
    await expect(host.createWindow({ logicalSize: [1, 1] })).rejects.toThrow(
      'Cannot create a window on a destroyed BrowserHost.'
    );
  });
});

async function waitForAnimationFrame(animationFrames: TestAnimationFrames): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (animationFrames.hasPendingFrame()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Browser runner did not request an animation frame.');
}

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WindowId } from '../../src';
import {
  createDOMBrowserPort,
  type DOMBrowserPortDependencies,
  type DOMCanvas
} from './browser-port';
import type { E2EBridge } from './types';

class TestCanvas implements DOMCanvas {
  width = 640;
  height = 360;

  getBoundingClientRect(): Pick<DOMRectReadOnly, 'height' | 'width'> {
    return { width: this.width, height: this.height };
  }
}

interface PortFixture {
  readonly canvas: TestCanvas;
  readonly dependencies: DOMBrowserPortDependencies;
  readonly fireResize: () => void;
  readonly fireClose: () => void;
  readonly resizeUnsubscribes: () => number;
  readonly closeUnsubscribes: () => number;
}

function createFixture(): PortFixture {
  const canvas = new TestCanvas();
  let dpr = 1;
  let resizeListener: (() => void) | undefined;
  let closeListener: (() => void) | undefined;
  let resizeUnsubscribes = 0;
  let closeUnsubscribes = 0;

  return {
    canvas,
    dependencies: {
      now: () => 123.5,
      requestAnimationFrame: (callback) => {
        callback(250);
        return 7;
      },
      cancelAnimationFrame: () => undefined,
      readDevicePixelRatio: () => dpr,
      readLogicalSize: (target) => {
        const rect = target.getBoundingClientRect();
        return [rect.width, rect.height];
      },
      observeResize: (target, listener) => {
        expect(target).toBe(canvas);
        resizeListener = listener;
        return () => {
          resizeUnsubscribes += 1;
          resizeListener = undefined;
        };
      },
      observeClose: (listener) => {
        closeListener = listener;
        return () => {
          closeUnsubscribes += 1;
          closeListener = undefined;
        };
      }
    },
    fireResize: () => {
      dpr = 2;
      resizeListener?.();
    },
    fireClose: () => closeListener?.(),
    resizeUnsubscribes: () => resizeUnsubscribes,
    closeUnsubscribes: () => closeUnsubscribes
  };
}

describe('createDOMBrowserPort', () => {
  test('maps the injected clock and animation frames and returns a canvas surface', async () => {
    const fixture = createFixture();
    const port = createDOMBrowserPort(fixture.canvas, fixture.dependencies);
    let frameTimestamp = 0;

    expect(port.clock.now()).toBe(123.5);
    expect(
      port.animationFrames.request((timestamp) => {
        frameTimestamp = timestamp;
      })
    ).toBe(7);
    expect(frameTimestamp).toBe(250);

    const windowPort = await port.createWindow(1 as WindowId, {
      logicalSize: [640, 360]
    });
    expect(windowPort.surfaceTarget).toEqual({
      id: expect.any(Symbol),
      kind: 'canvas'
    });
  });

  test('emits immutable logical-size and DPR snapshots when resize is observed', async () => {
    const fixture = createFixture();
    const port = createDOMBrowserPort(fixture.canvas, fixture.dependencies);
    const windowPort = await port.createWindow(1 as WindowId, {
      logicalSize: [640, 360]
    });
    const updates: unknown[] = [];
    windowPort.onMetrics((update) => updates.push(update));

    fixture.canvas.width = 800;
    fixture.canvas.height = 450;
    fixture.fireResize();

    expect(updates).toEqual([{ logicalSize: [800, 450], devicePixelRatio: 2 }]);
    expect(Object.isFrozen(updates[0])).toBe(true);
    expect(Object.isFrozen((updates[0] as { logicalSize: unknown }).logicalSize)).toBe(true);
  });

  test('close unregisters observations once and releases registered callbacks', async () => {
    const fixture = createFixture();
    const port = createDOMBrowserPort(fixture.canvas, fixture.dependencies);
    const windowPort = await port.createWindow(1 as WindowId, {
      logicalSize: [640, 360]
    });
    let metricCalls = 0;
    let closeCalls = 0;
    const unsubscribeMetrics = windowPort.onMetrics(() => {
      metricCalls += 1;
    });
    const unsubscribeClose = windowPort.onClose(() => {
      closeCalls += 1;
    });

    windowPort.close();
    windowPort.close();
    fixture.fireResize();
    fixture.fireClose();
    unsubscribeMetrics();
    unsubscribeClose();

    expect(fixture.resizeUnsubscribes()).toBe(1);
    expect(fixture.closeUnsubscribes()).toBe(1);
    expect(metricCalls).toBe(0);
    expect(closeCalls).toBe(0);
  });
});

interface HarnessFixture {
  readonly bridge: E2EBridge;
  readonly frameCount: () => number;
  readonly flushFrames: () => void;
  readonly rejectNewFrames: () => void;
  readonly resizeEvents: () => number;
}

class HarnessCanvas extends EventTarget {
  readonly style = { width: '', height: '' };
  width = 0;
  height = 0;
  removed = false;

  getBoundingClientRect(): Pick<DOMRectReadOnly, 'height' | 'width'> {
    return {
      width: Number.parseFloat(this.style.width),
      height: Number.parseFloat(this.style.height)
    };
  }

  getContext(kind: string): object | null {
    return kind === 'webgl2' ? {} : null;
  }

  setAttribute(): void {}

  remove(): void {
    this.removed = true;
  }
}

async function createHarnessFixture(): Promise<HarnessFixture> {
  const callbacks = new Map<number, FrameRequestCallback>();
  const canvas = new HarnessCanvas();
  const eventTarget = new EventTarget();
  let nextFrameId = 1;
  let acceptingFrames = true;
  let resizeEvents = 0;

  const testWindow = {
    performance: { now: () => 10 },
    devicePixelRatio: 1,
    location: { search: '?scenario=browser-host' },
    requestAnimationFrame(callback: FrameRequestCallback) {
      if (!acceptingFrames) throw new Error('A frame was requested after teardown started.');
      const id = nextFrameId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      callbacks.delete(id);
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      eventTarget.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      eventTarget.removeEventListener(type, listener);
    },
    dispatchEvent(event: Event) {
      if (event.type === 'resize') resizeEvents += 1;
      return eventTarget.dispatchEvent(event);
    }
  } as unknown as Window & typeof globalThis;
  const testDocument = {
    createElement: () => canvas,
    body: { append: () => undefined }
  } as unknown as Document;

  class TestResizeObserver {
    constructor(private readonly listener: ResizeObserverCallback) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  vi.stubGlobal('window', testWindow);
  vi.stubGlobal('document', testDocument);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.resetModules();
  await import('./main');
  await vi.waitFor(() => {
    expect(testWindow.__AETHER_E2E__.state().status).toBe('ready');
  });

  return {
    bridge: testWindow.__AETHER_E2E__,
    frameCount: () => callbacks.size,
    flushFrames: () => {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(20);
    },
    rejectNewFrames: () => {
      acceptingFrames = false;
    },
    resizeEvents: () => resizeEvents
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser E2E bridge integration', () => {
  test('routes resize through the DOM port and commits metrics at a frame boundary', async () => {
    const fixture = await createHarnessFixture();
    const resize = fixture.bridge.resize(800, 450, 2);

    await vi.waitFor(() => {
      expect(fixture.frameCount()).toBe(1);
    });
    expect(fixture.resizeEvents()).toBe(1);
    expect(fixture.bridge.state()).toMatchObject({
      status: 'ready',
      detail: {
        logicalSize: [640, 360],
        physicalSize: [640, 360],
        generation: 0
      }
    });

    fixture.flushFrames();
    await resize;

    expect(fixture.bridge.state()).toMatchObject({
      status: 'ready',
      detail: {
        logicalSize: [800, 450],
        physicalSize: [1600, 900],
        devicePixelRatio: 2,
        generation: 1
      }
    });
  });

  test('teardown cancels a delayed resize and prevents ready-state resurrection', async () => {
    const fixture = await createHarnessFixture();
    const resize = fixture.bridge.resize(800, 450, 2);
    await vi.waitFor(() => {
      expect(fixture.frameCount()).toBe(1);
    });

    const teardown = fixture.bridge.teardown();
    fixture.rejectNewFrames();
    await expect(fixture.bridge.resize(1024, 576, 1)).rejects.toThrow(
      'The E2E harness is tearing down.'
    );
    await teardown;
    await resize;
    fixture.flushFrames();

    expect(fixture.frameCount()).toBe(0);
    expect(fixture.bridge.state()).toEqual({ status: 'destroyed' });
  });
});

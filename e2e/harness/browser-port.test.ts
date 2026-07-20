import { describe, expect, test } from 'vitest';
import type { WindowId } from '../../src';
import {
  createDOMBrowserPort,
  type DOMBrowserPortDependencies,
  type DOMCanvas
} from './browser-port';

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

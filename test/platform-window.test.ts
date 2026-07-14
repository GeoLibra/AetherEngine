import { describe, expect, test } from 'vitest';
import { PlatformWindow, type WindowId, type WindowOptions } from '../src';

function createWindow(options: Partial<WindowOptions> = {}): PlatformWindow {
  return new PlatformWindow(1 as WindowId, {
    logicalSize: [640, 360],
    ...options
  });
}

describe('PlatformWindow', () => {
  test('coalesces pending metrics into one immutable frame-boundary snapshot', () => {
    const window = createWindow();

    window.queueMetrics({ logicalSize: [800, 450] });
    window.queueMetrics({ devicePixelRatio: 2 });

    expect(window.metrics.logicalSize).toEqual([640, 360]);
    expect(window.generation).toBe(0);
    expect(window.commitFrameBoundary()).toBe(true);
    expect(window.metrics).toEqual({
      logicalSize: [800, 450],
      physicalSize: [1600, 900],
      devicePixelRatio: 2,
      visible: true,
      focused: false
    });
    expect(window.generation).toBe(1);
    expect(Object.isFrozen(window.metrics)).toBe(true);
    expect(Object.isFrozen(window.metrics.logicalSize)).toBe(true);
  });

  test('does not mutate caller-owned sizes and rounds physical extent deterministically', () => {
    const logicalSize: [number, number] = [101, 51];
    const window = createWindow({ logicalSize, devicePixelRatio: 1.5 });

    logicalSize[0] = 999;

    expect(window.metrics.logicalSize).toEqual([101, 51]);
    expect(window.metrics.physicalSize).toEqual([152, 77]);
  });

  test('treats hidden and zero-sized windows as non-renderable', () => {
    const window = createWindow();
    expect(window.renderable).toBe(true);

    window.queueMetrics({ visible: false });
    window.commitFrameBoundary();
    expect(window.renderable).toBe(false);

    window.queueMetrics({ visible: true, logicalSize: [0, 0] });
    window.commitFrameBoundary();
    expect(window.metrics.physicalSize).toEqual([0, 0]);
    expect(window.renderable).toBe(false);
  });

  test('skips a generation for queued values that do not change the snapshot', () => {
    const window = createWindow();

    window.queueMetrics({ logicalSize: [640, 360], devicePixelRatio: 1 });

    expect(window.commitFrameBoundary()).toBe(false);
    expect(window.generation).toBe(0);
  });

  test('validates metrics and rejects updates after idempotent close', () => {
    expect(() => createWindow({ logicalSize: [-1, 10] })).toThrow(
      'Window logical size must contain non-negative finite values.'
    );
    const window = createWindow();
    expect(() => window.queueMetrics({ devicePixelRatio: 0 })).toThrow(
      'Window devicePixelRatio must be a positive finite number.'
    );

    window.queueMetrics({ logicalSize: [800, 450] });
    window.close();
    window.close();

    expect(window.state).toBe('closed');
    expect(window.renderable).toBe(false);
    expect(window.commitFrameBoundary()).toBe(false);
    expect(() => window.queueMetrics({ visible: true })).toThrow(
      'Cannot update closed window 1.'
    );
  });
});

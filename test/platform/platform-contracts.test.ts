import { describe, expect, test } from 'vitest';
import type {
  Host,
  HostWindow,
  MonotonicClock,
  PlatformServiceRegistry,
  RunnerOptions,
  SurfaceTarget,
  WindowMetrics
} from '../../src';

describe('Platform contracts', () => {
  test('publish platform-neutral clock, window, surface, and host shapes', () => {
    const clock: MonotonicClock = { now: () => 1 };
    const metrics: WindowMetrics = {
      logicalSize: [640, 360],
      physicalSize: [1280, 720],
      devicePixelRatio: 2,
      visible: true,
      focused: false
    };
    const surface: SurfaceTarget = {
      id: Symbol('test-surface'),
      kind: 'offscreen'
    };
    const runner: RunnerOptions = { kind: 'headless', frames: 1 };

    expect(clock.now()).toBe(1);
    expect(metrics.physicalSize).toEqual([1280, 720]);
    expect(Object.keys(metrics)).not.toContain('canvas');
    expect(surface.kind).toBe('offscreen');
    expect(runner.kind).toBe('headless');

    // These assertions keep the public aggregate contracts type-checked without
    // requiring a concrete platform implementation in this contract slice.
    expectTypeOnly<Host>();
    expectTypeOnly<HostWindow>();
    expectTypeOnly<PlatformServiceRegistry>();
  });
});

function expectTypeOnly<T>(): void {
  void (undefined as T | undefined);
}

import { describe, expect, test } from 'vitest';

import {
  NativeCancellationSource,
  NativeHandleRegistry,
  NativeHost,
  NativeLifecycleCoordinator,
  NativeRuntimeController,
  createNativeSensorService,
  type JsRuntimePort,
  type NativeFramePort,
  type NativePlatformPort,
  type NativeThreadPort,
  type NativeWindowPort,
  type SurfaceTarget,
  type WindowId,
  type WindowOptions
} from '../../src';

class Runtime implements JsRuntimePort {
  readonly id = 'conformance';
  checkpointMicrotasks(): void {}
  destroy(): void {}
}

class Threads implements NativeThreadPort {
  readonly jsThread = 'js';
  currentThread(): string {
    return this.jsThread;
  }
  dispatchToJs(operation: () => void): void {
    operation();
  }
}

class Frames implements NativeFramePort {
  request(): number {
    return 1;
  }
  cancel(): void {}
}

class ConformancePlatform implements NativePlatformPort {
  readonly clock = { now: () => 0 };
  readonly frames = new Frames();
  liveWindows = 0;
  destroys = 0;

  createWindow(_id: WindowId, options: WindowOptions): NativeWindowPort {
    this.liveWindows += 1;
    let open = true;
    return {
      surfaceTarget: options.surfaceTarget,
      onMetrics: () => () => undefined,
      onSurface: () => () => undefined,
      onClose: () => () => undefined,
      close: () => {
        if (!open) return;
        open = false;
        this.liveWindows -= 1;
      }
    };
  }
  pollEvents(): void {}
  destroy(): void {
    this.destroys += 1;
  }
}

const surface = (): SurfaceTarget => Object.freeze({ id: Symbol('native'), kind: 'native-window' });

describe('native runtime structural conformance', () => {
  test('completes 100 handle/listener/window create-destroy cycles without live entries', async () => {
    const registry = new NativeHandleRegistry<object>({ owner: 'soak', destroy: () => undefined });
    let sensorListeners = 0;
    const sensors = createNativeSensorService({
      subscribe: () => {
        sensorListeners += 1;
        return () => {
          sensorListeners -= 1;
        };
      }
    });

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const handle = registry.create('buffer', {});
      const lease = registry.lease(handle, 'buffer');
      registry.release(handle);
      lease.release();

      const unsubscribe = sensors.subscribe('accelerometer', () => undefined);
      unsubscribe();

      const platform = new ConformancePlatform();
      const runtime = new NativeRuntimeController({
        ownership: 'embedded',
        threads: new Threads(),
        runtime: new Runtime()
      });
      const host = new NativeHost(platform, runtime);
      await host.createWindow({ logicalSize: [16, 16], surfaceTarget: surface() });
      host.destroy();

      expect(platform.liveWindows).toBe(0);
      expect(platform.destroys).toBe(1);
    }

    expect(registry.liveEntries).toBe(0);
    expect(sensorListeners).toBe(0);
  });

  test('keeps lifecycle and cancellation cleanup single-terminal across resume boundaries', () => {
    const lifecycle = new NativeLifecycleCoordinator({
      simulation: 'pause',
      render: 'pause',
      audio: 'pause'
    });
    const events: string[] = [];
    const unsubscribe = lifecycle.subscribe((event) => events.push(event.kind));
    lifecycle.background();
    lifecycle.surfaceLost(1);
    lifecycle.surfaceRecreated(2);
    lifecycle.foreground();
    expect(events).toEqual(['background', 'surface-lost', 'surface-recreated', 'foreground']);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    const cancellation = new NativeCancellationSource();
    let cancellations = 0;
    cancellation.token.subscribe(() => {
      cancellations += 1;
    });
    expect(cancellation.cancel()).toBe(true);
    expect(cancellation.cancel()).toBe(false);
    expect(cancellations).toBe(1);
    expect(lifecycle.terminate()).toBe(true);
    expect(lifecycle.terminate()).toBe(false);
  });
});

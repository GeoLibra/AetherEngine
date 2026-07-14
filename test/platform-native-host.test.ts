import { describe, expect, test } from 'vitest';

import {
  NativeHost,
  NativeRuntimeController,
  type JsRuntimePort,
  type NativeFramePort,
  type NativePlatformPort,
  type NativeThreadPort,
  type NativeWindowPort,
  type RunnerContext,
  type SurfaceTarget,
  type WindowId,
  type WindowMetricsUpdate,
  type WindowOptions
} from '../src';

class Threads implements NativeThreadPort {
  readonly jsThread = 'js';
  current = 'native';
  currentThread(): string { return this.current; }
  dispatchToJs(operation: () => void): void { operation(); }
}

class Runtime implements JsRuntimePort {
  readonly id = 'native-runtime';
  checkpoints = 0;
  destroys = 0;
  constructor(private readonly events: string[]) {}
  checkpointMicrotasks(): void { this.checkpoints += 1; }
  destroy(): void { this.destroys += 1; this.events.push('runtime.destroy'); }
}

class Frames implements NativeFramePort {
  private nextId = 1;
  readonly callbacks = new Map<number, (timestampSeconds: number) => void>();
  request(callback: (timestampSeconds: number) => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }
  cancel(id: number): void { this.callbacks.delete(id); }
  fire(timestampSeconds: number): void {
    const entry = this.callbacks.entries().next().value as [number, (time: number) => void] | undefined;
    if (entry === undefined) throw new Error('No native frame is pending.');
    this.callbacks.delete(entry[0]);
    entry[1](timestampSeconds);
  }
}

class WindowPort implements NativeWindowPort {
  private metricsListener: (update: WindowMetricsUpdate) => void = () => undefined;
  private surfaceListener: (surface: SurfaceTarget | undefined) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  closes = 0;

  constructor(readonly surfaceTarget: SurfaceTarget | undefined, private readonly events: string[]) {}
  onMetrics(listener: (update: WindowMetricsUpdate) => void): () => void {
    this.metricsListener = listener;
    return () => { this.metricsListener = () => undefined; };
  }
  onSurface(listener: (surface: SurfaceTarget | undefined) => void): () => void {
    this.surfaceListener = listener;
    return () => { this.surfaceListener = () => undefined; };
  }
  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => { this.closeListener = () => undefined; };
  }
  emitMetrics(update: WindowMetricsUpdate): void { this.metricsListener(update); }
  emitSurface(surface: SurfaceTarget | undefined): void { this.surfaceListener(surface); }
  emitClose(): void { this.closeListener(); }
  close(): void { this.closes += 1; this.events.push('window.close'); }
}

class Platform implements NativePlatformPort {
  readonly frames = new Frames();
  readonly windows: WindowPort[] = [];
  readonly pendingEvents: Array<() => void> = [];
  destroys = 0;
  readonly clock = { now: () => 0 };

  constructor(private readonly events: string[]) {}
  createWindow(_id: WindowId, options: WindowOptions): NativeWindowPort {
    const port = new WindowPort(options.surfaceTarget, this.events);
    this.windows.push(port);
    return port;
  }
  pollEvents(): void {
    for (const event of this.pendingEvents.splice(0)) event();
  }
  destroy(): void { this.destroys += 1; this.events.push('platform.destroy'); }
}

const surface = (label: string): SurfaceTarget => Object.freeze({
  id: Symbol(label), kind: 'native-window'
});

async function setup() {
  const events: string[] = [];
  const threads = new Threads();
  const runtimePort = new Runtime(events);
  const runtime = new NativeRuntimeController({
    ownership: 'dedicated', threads, createRuntime: () => runtimePort
  });
  const platform = new Platform(events);
  const host = new NativeHost(platform, runtime);
  return { events, host, platform, runtimePort, threads };
}

describe('NativeHost', () => {
  test('publishes coalesced platform state before callback-driven App frames', async () => {
    const { host, platform, runtimePort, threads } = await setup();
    const first = await host.createWindow({ logicalSize: [100, 50], surfaceTarget: surface('first') });
    const second = await host.createWindow({ logicalSize: [40, 40], surfaceTarget: surface('second') });
    const observations: Array<{ time: number; width: number; generation: number }> = [];
    const runner = host.createRunner({ kind: 'native' });
    const run = runner.run({
      stopRequested: false,
      frame(time) {
        observations.push({ time, width: first.metrics.logicalSize[0], generation: first.generation });
        return { frame: observations.length };
      }
    });

    platform.pendingEvents.push(
      () => platform.windows[0]!.emitMetrics({ logicalSize: [120, 50] }),
      () => platform.windows[0]!.emitMetrics({ logicalSize: [140, 50] })
    );
    threads.current = threads.jsThread;
    platform.frames.fire(1.5);
    expect(observations).toEqual([{ time: 1.5, width: 140, generation: 1 }]);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(0);
    expect(runtimePort.checkpoints).toBe(2);

    runner.requestStop('test-complete');
    await expect(run).resolves.toEqual({ reason: 'test-complete', frames: 1 });
  });

  test('coalesces surface destroy/recreate and zero extent at frame boundaries', async () => {
    const { host, platform, threads } = await setup();
    const initialSurface = surface('initial');
    const replacement = surface('replacement');
    const window = await host.createWindow({ logicalSize: [64, 64], surfaceTarget: initialSurface });
    const runner = host.createRunner({ kind: 'native' });
    const run = runner.run({ stopRequested: false, frame: () => ({ frame: 0 }) });
    threads.current = threads.jsThread;

    platform.pendingEvents.push(
      () => platform.windows[0]!.emitMetrics({ logicalSize: [0, 64] }),
      () => platform.windows[0]!.emitSurface(undefined)
    );
    platform.frames.fire(1);
    expect(window.renderable).toBe(false);
    expect(window.surfaceTarget).toBeUndefined();
    expect(window.generation).toBe(1);

    platform.pendingEvents.push(
      () => platform.windows[0]!.emitMetrics({ logicalSize: [64, 64] }),
      () => platform.windows[0]!.emitSurface(replacement)
    );
    platform.frames.fire(2);
    expect(window.renderable).toBe(true);
    expect(window.surfaceTarget).toBe(replacement);
    expect(window.generation).toBe(2);
    runner.requestStop('done');
    await run;
  });

  test('rejects non-monotonic timestamps and cleans up frame exceptions', async () => {
    const { host, platform, threads } = await setup();
    threads.current = threads.jsThread;
    const monotonic = host.createRunner({ kind: 'native' });
    const firstRun = monotonic.run({ stopRequested: false, frame: () => ({ frame: 0 }) });
    platform.frames.fire(2);
    platform.frames.fire(1);
    await expect(firstRun).rejects.toThrow(/monotonic/i);
    expect(platform.frames.callbacks.size).toBe(0);

    const failing = host.createRunner({ kind: 'native' });
    const failedRun = failing.run({
      stopRequested: false,
      frame() { throw new Error('frame failed'); }
    } as RunnerContext);
    platform.frames.fire(3);
    await expect(failedRun).rejects.toThrow('frame failed');
    expect(platform.frames.callbacks.size).toBe(0);
  });

  test('destroys surfaces/platform before its owned runtime exactly once', async () => {
    const { events, host, platform, runtimePort } = await setup();
    await host.createWindow({ logicalSize: [10, 10], surfaceTarget: surface('owned') });

    host.destroy();
    host.destroy();

    expect(host.state).toBe('destroyed');
    expect(platform.windows[0]!.closes).toBe(1);
    expect(platform.destroys).toBe(1);
    expect(runtimePort.destroys).toBe(1);
    expect(events).toEqual(['window.close', 'platform.destroy', 'runtime.destroy']);
  });
});

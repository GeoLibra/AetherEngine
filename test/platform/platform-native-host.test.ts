import { describe, expect, test } from 'vitest';

import {
  NativeHost,
  NativeHostDestroyError,
  NativeRuntimeController,
  type JsRuntimePort,
  type NativeFramePort,
  type NativePlatformLifecycleEvent,
  type NativePlatformPort,
  type NativeThreadPort,
  type NativeWindowPort,
  type RunnerContext,
  type SurfaceTarget,
  type WindowId,
  type WindowMetricsUpdate,
  type WindowOptions
} from '../../src';

class Threads implements NativeThreadPort {
  readonly jsThread = 'js';
  current = 'native';
  readonly queued: Array<() => void> = [];
  currentThread(): string { return this.current; }
  dispatchToJs(operation: () => void): void { this.queued.push(operation); }
  drain(): void {
    this.current = this.jsThread;
    for (const operation of this.queued.splice(0)) operation();
  }
}

class Runtime implements JsRuntimePort {
  readonly id = 'native-runtime';
  checkpoints = 0;
  destroys = 0;
  throwOnDestroy = false;
  constructor(private readonly events: string[]) {}
  checkpointMicrotasks(): void { this.checkpoints += 1; }
  destroy(): void {
    this.destroys += 1;
    this.events.push('runtime.destroy');
    if (this.throwOnDestroy) throw new Error('runtime cleanup');
  }
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
  throwOnClose = false;

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
  close(): void {
    this.closes += 1;
    this.events.push('window.close');
    if (this.throwOnClose) throw new Error('window cleanup');
  }
}

class Platform implements NativePlatformPort {
  readonly frames = new Frames();
  readonly windows: WindowPort[] = [];
  readonly pendingEvents: Array<() => void> = [];
  destroys = 0;
  throwOnDestroy = false;
  readonly clock = { now: () => 0 };
  private lifecycleListener: (event: NativePlatformLifecycleEvent) => void = () => undefined;

  constructor(private readonly events: string[]) {}
  createWindow(_id: WindowId, options: WindowOptions): NativeWindowPort {
    const port = new WindowPort(options.surfaceTarget, this.events);
    this.windows.push(port);
    return port;
  }
  pollEvents(): void {
    for (const event of this.pendingEvents.splice(0)) event();
  }
  onLifecycle(listener: (event: NativePlatformLifecycleEvent) => void): () => void {
    this.lifecycleListener = listener;
    return () => { this.lifecycleListener = () => undefined; };
  }
  emitLifecycle(event: NativePlatformLifecycleEvent): void { this.lifecycleListener(event); }
  destroy(): void {
    this.destroys += 1;
    this.events.push('platform.destroy');
    if (this.throwOnDestroy) throw new Error('platform cleanup');
  }
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
  test('routes JS-thread platform lifecycle events through the owned coordinator', async () => {
    const { host, platform, threads } = await setup();
    const events: string[] = [];
    const evictionBudgets: number[] = [];
    host.lifecycle.subscribe((snapshot) => events.push(snapshot.kind));
    host.lifecycle.registerEvictor({
      name: 'test-cache',
      priority: 1,
      evict: (budget) => { evictionBudgets.push(budget); return budget; }
    });

    expect(() => platform.emitLifecycle({ kind: 'background' })).toThrow(/requires thread "js"/);
    threads.current = threads.jsThread;
    platform.emitLifecycle({ kind: 'background' });
    platform.emitLifecycle({ kind: 'audio-interruption', interrupted: true });
    platform.emitLifecycle({ kind: 'orientation', orientation: 'landscape' });
    platform.emitLifecycle({ kind: 'resize', size: [1280, 720] });
    platform.emitLifecycle({ kind: 'surface-lost', generation: 4 });
    platform.emitLifecycle({ kind: 'surface-recreated', generation: 5 });
    platform.emitLifecycle({
      kind: 'memory-pressure',
      pressure: { severity: 'critical', targetBytes: 64, maxCallbacks: 1 }
    });
    platform.emitLifecycle({ kind: 'foreground' });

    expect(events).toEqual([
      'background',
      'audio-interruption',
      'orientation',
      'resize',
      'surface-lost',
      'surface-recreated',
      'foreground'
    ]);
    expect(evictionBudgets).toEqual([64]);
    host.destroy();
    expect(() => host.lifecycle.foreground()).toThrow('Native lifecycle is terminated.');
  });

  test('marshals platform frame callbacks to the JS owner before entering App code', async () => {
    const { host, platform, threads } = await setup();
    const calls: number[] = [];
    const runner = host.createRunner({ kind: 'native' });
    const run = runner.run({
      stopRequested: false,
      frame(time) { calls.push(time); return { frame: calls.length }; }
    });

    platform.frames.fire(0.5);
    expect(calls).toEqual([]);
    expect(threads.queued).toHaveLength(1);
    threads.drain();
    await Promise.resolve();
    expect(calls).toEqual([0.5]);
    runner.requestStop('done');
    await run;
  });

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

  test('removes closed windows without skipping later host cleanup', async () => {
    const { host, platform } = await setup();
    const first = await host.createWindow({ logicalSize: [10, 10], surfaceTarget: surface('first') });
    const second = await host.createWindow({ logicalSize: [20, 20], surfaceTarget: surface('second') });

    platform.windows[0]!.emitClose();
    expect(host.windows()).toEqual([second]);
    expect(first.state).toBe('closed');

    host.destroy();
    expect(platform.windows.map((window) => window.closes)).toEqual([0, 1]);
    expect(host.windows()).toEqual([]);
  });

  test('aggregates cleanup failures without skipping later native layers', async () => {
    const { events, host, platform, runtimePort } = await setup();
    await host.createWindow({ logicalSize: [10, 10], surfaceTarget: surface('failing') });
    platform.windows[0]!.throwOnClose = true;
    platform.throwOnDestroy = true;
    runtimePort.throwOnDestroy = true;

    let error: unknown;
    try { host.destroy(); } catch (caught) { error = caught; }

    expect(error).toBeInstanceOf(NativeHostDestroyError);
    expect((error as NativeHostDestroyError).errors).toHaveLength(3);
    expect(events).toEqual(['window.close', 'platform.destroy', 'runtime.destroy']);
    expect(() => host.destroy()).not.toThrow();
  });

  test('rolls back the native window when listener setup fails', async () => {
    const { host, platform } = await setup();
    let metricUnsubscribes = 0;
    let closes = 0;
    platform.createWindow = () => ({
      surfaceTarget: undefined,
      onMetrics: () => () => { metricUnsubscribes += 1; },
      onSurface: () => { throw new Error('surface listener failed'); },
      onClose: () => () => undefined,
      close: () => { closes += 1; }
    });

    await expect(host.createWindow({ logicalSize: [1, 1] })).rejects.toThrow('surface listener failed');
    expect(metricUnsubscribes).toBe(1);
    expect(closes).toBe(1);
    expect(host.windows()).toEqual([]);
  });
});

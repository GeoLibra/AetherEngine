import type { NativeRuntimeController } from '../native-runtime/runtime';
import { NativeLifecycleCoordinator } from '../native-runtime/lifecycle';
import type { NativeBackgroundPolicy } from '../native-runtime/lifecycle-types';
import { MutablePlatformServiceRegistry } from './services';
import { PlatformWindow } from './window';
import { NativeRunner } from './native-runner';
import type { NativePlatformLifecycleEvent, NativePlatformPort } from './native-host-types';
import type { Host, HostState, RunnerOptions, WindowId, WindowOptions } from './types';

interface NativeWindowLifecycle {
  closingFromPort: boolean;
  unsubscribeMetrics: () => void;
  unsubscribeSurface: () => void;
  unsubscribeClose: () => void;
}

export class NativeHostDestroyError extends Error {
  readonly errors: readonly unknown[];
  constructor(errors: readonly unknown[]) {
    super(`NativeHost cleanup failed (${errors.length}).`);
    this.name = 'NativeHostDestroyError';
    this.errors = Object.freeze([...errors]);
  }
}

export class NativeHost implements Host {
  readonly kind = 'native' as const;
  readonly clock;
  readonly services = new MutablePlatformServiceRegistry();
  readonly lifecycle: NativeLifecycleCoordinator;
  private currentState: HostState = 'active';
  private nextWindowId = 1;
  private readonly ownedWindows: PlatformWindow[] = [];
  private readonly runners = new Set<NativeRunner>();
  private readonly unsubscribeLifecycle: () => void;

  constructor(
    private readonly port: NativePlatformPort,
    private readonly runtime: NativeRuntimeController,
    backgroundPolicy: NativeBackgroundPolicy = DEFAULT_NATIVE_BACKGROUND_POLICY
  ) {
    this.clock = port.clock;
    this.lifecycle = new NativeLifecycleCoordinator(backgroundPolicy);
    this.unsubscribeLifecycle = port.onLifecycle?.((event) => this.handleLifecycle(event)) ?? (() => undefined);
  }

  get state(): HostState { return this.currentState; }

  async createWindow(options: WindowOptions): Promise<PlatformWindow> {
    this.assertActive('create a window');
    const id = this.nextWindowId++ as WindowId;
    const windowPort = await this.port.createWindow(id, options);
    if (this.currentState === 'destroyed') {
      windowPort.close();
      throw new Error('Cannot create a window on a destroyed NativeHost.');
    }
    const lifecycle: NativeWindowLifecycle = {
      closingFromPort: false,
      unsubscribeMetrics: () => undefined,
      unsubscribeSurface: () => undefined,
      unsubscribeClose: () => undefined
    };
    const surfaceTarget = windowPort.surfaceTarget ?? options.surfaceTarget;
    const windowOptions = surfaceTarget === undefined ? options : { ...options, surfaceTarget };
    const window = new PlatformWindow(
      id,
      windowOptions,
      () => {
        this.removeWindow(window);
        lifecycle.unsubscribeMetrics();
        lifecycle.unsubscribeSurface();
        lifecycle.unsubscribeClose();
        if (!lifecycle.closingFromPort) windowPort.close();
      },
      true
    );
    try {
      lifecycle.unsubscribeMetrics = windowPort.onMetrics((update) => window.queueMetrics(update));
      lifecycle.unsubscribeSurface = windowPort.onSurface((target) => window.queueSurfaceTarget(target));
      lifecycle.unsubscribeClose = windowPort.onClose(() => {
        lifecycle.closingFromPort = true;
        try { window.close(); } finally { lifecycle.closingFromPort = false; }
      });
    } catch (error) {
      rollbackWindowSetup(window, error, 'NativeHost');
    }
    this.ownedWindows.push(window);
    return window;
  }

  createRunner(options: RunnerOptions): NativeRunner {
    this.assertActive('create a runner');
    if (options.kind !== 'native') throw new Error('NativeHost only supports native runners.');
    const runner = new NativeRunner(this.port.frames, {
      dispatchFrame: (run) => {
        if (this.runtime.isOnJsThread()) {
          this.runtime.enterJsThread('native.frame', run);
          return Promise.resolve();
        }
        return this.runtime.runOnJsThread('native.frame', run).then(() => undefined);
      },
      beforeFrame: () => {
        this.assertActive('run a frame');
        this.port.pollEvents();
        for (const window of this.ownedWindows) window.commitFrameBoundary();
        this.runtime.checkpointMicrotasks();
      },
      afterFrame: () => this.runtime.checkpointMicrotasks()
    });
    this.runners.add(runner);
    return runner;
  }

  windows(): readonly PlatformWindow[] { return Object.freeze([...this.ownedWindows]); }

  destroy(): void {
    if (this.currentState === 'destroyed') return;
    this.currentState = 'destroyed';
    const errors: unknown[] = [];
    // Teardown is best-effort across every owned layer; one faulty port must not strand the runtime.
    for (const runner of this.runners) captureCleanup(errors, () => runner.requestStop('host-destroyed'));
    // Closing mutates the registry, so teardown must iterate a stable snapshot.
    for (const window of [...this.ownedWindows]) captureCleanup(errors, () => window.close());
    captureCleanup(errors, this.unsubscribeLifecycle);
    captureCleanup(errors, () => this.lifecycle.terminate());
    captureCleanup(errors, () => this.port.destroy());
    captureCleanup(errors, () => this.runtime.destroy());
    if (errors.length > 0) throw new NativeHostDestroyError(errors);
  }

  private assertActive(operation: string): void {
    if (this.currentState === 'destroyed') {
      throw new Error(`Cannot ${operation} on a destroyed NativeHost.`);
    }
  }

  private removeWindow(window: PlatformWindow): void {
    const index = this.ownedWindows.indexOf(window);
    if (index >= 0) this.ownedWindows.splice(index, 1);
  }

  private handleLifecycle(event: NativePlatformLifecycleEvent): void {
    this.runtime.enterJsThread('native.lifecycle', () => {
      switch (event.kind) {
        case 'foreground': this.lifecycle.foreground(); return;
        case 'background': this.lifecycle.background(); return;
        case 'audio-interruption': this.lifecycle.audioInterrupted(event.interrupted); return;
        case 'orientation': this.lifecycle.orientation(event.orientation); return;
        case 'resize': this.lifecycle.resize(event.size); return;
        case 'surface-lost': this.lifecycle.surfaceLost(event.generation); return;
        case 'surface-recreated': this.lifecycle.surfaceRecreated(event.generation); return;
        case 'memory-pressure': this.lifecycle.memoryPressure(event.pressure); return;
      }
    });
  }
}

const DEFAULT_NATIVE_BACKGROUND_POLICY: NativeBackgroundPolicy = Object.freeze({
  simulation: 'pause',
  render: 'pause',
  audio: 'pause'
});

function captureCleanup(errors: unknown[], cleanup: () => void): void {
  try { cleanup(); } catch (error) { errors.push(error); }
}

function rollbackWindowSetup(window: PlatformWindow, setupError: unknown, hostName: string): never {
  try {
    window.close();
  } catch (cleanupError) {
    throw new AggregateError([setupError, cleanupError], `${hostName} window setup and cleanup failed.`);
  }
  throw setupError;
}

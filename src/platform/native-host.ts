import type { NativeRuntimeController } from '../native-runtime/runtime';
import { MutablePlatformServiceRegistry } from './services';
import { PlatformWindow } from './window';
import { NativeRunner } from './native-runner';
import type { NativePlatformPort } from './native-host-types';
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
  private currentState: HostState = 'active';
  private nextWindowId = 1;
  private readonly ownedWindows: PlatformWindow[] = [];
  private readonly runners = new Set<NativeRunner>();

  constructor(
    private readonly port: NativePlatformPort,
    private readonly runtime: NativeRuntimeController
  ) {
    this.clock = port.clock;
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
        lifecycle.unsubscribeMetrics();
        lifecycle.unsubscribeSurface();
        lifecycle.unsubscribeClose();
        if (!lifecycle.closingFromPort) windowPort.close();
      },
      true
    );
    lifecycle.unsubscribeMetrics = windowPort.onMetrics((update) => window.queueMetrics(update));
    lifecycle.unsubscribeSurface = windowPort.onSurface((target) => window.queueSurfaceTarget(target));
    lifecycle.unsubscribeClose = windowPort.onClose(() => {
      lifecycle.closingFromPort = true;
      try { window.close(); } finally { lifecycle.closingFromPort = false; }
    });
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
    for (const window of this.ownedWindows) captureCleanup(errors, () => window.close());
    captureCleanup(errors, () => this.port.destroy());
    captureCleanup(errors, () => this.runtime.destroy());
    if (errors.length > 0) throw new NativeHostDestroyError(errors);
  }

  private assertActive(operation: string): void {
    if (this.currentState === 'destroyed') {
      throw new Error(`Cannot ${operation} on a destroyed NativeHost.`);
    }
  }
}

function captureCleanup(errors: unknown[], cleanup: () => void): void {
  try { cleanup(); } catch (error) { errors.push(error); }
}

import { BrowserRunner, type AnimationFrameHost } from '../app/runner';
import type { MonotonicClock } from '../core/clock';
import { HostBoundaryRunner } from './host-runner';
import { MutablePlatformServiceRegistry } from './services';
import type {
  Host,
  HostState,
  RunnerOptions,
  SurfaceTarget,
  WindowId,
  WindowMetricsUpdate,
  WindowOptions
} from './types';
import { PlatformWindow } from './window';

export interface BrowserWindowPort {
  readonly surfaceTarget?: SurfaceTarget;
  onMetrics(listener: (update: WindowMetricsUpdate) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface BrowserPlatformPort {
  readonly clock: MonotonicClock;
  readonly animationFrames: AnimationFrameHost;
  createWindow(
    id: WindowId,
    options: WindowOptions
  ): BrowserWindowPort | Promise<BrowserWindowPort>;
}

interface BrowserWindowLifecycle {
  closingFromPort: boolean;
  unsubscribeMetrics: () => void;
  unsubscribeClose: () => void;
}

export class BrowserHost implements Host {
  readonly kind = 'browser' as const;
  readonly clock: MonotonicClock;
  readonly services = new MutablePlatformServiceRegistry();
  private currentState: HostState = 'active';
  private nextWindowId = 1;
  private readonly ownedWindows: PlatformWindow[] = [];

  constructor(private readonly port: BrowserPlatformPort) {
    this.clock = port.clock;
  }

  get state(): HostState {
    return this.currentState;
  }

  async createWindow(options: WindowOptions): Promise<PlatformWindow> {
    this.assertActive('create a window');
    const id = this.nextWindowId++ as WindowId;
    const windowPort = await this.port.createWindow(id, options);
    if (this.currentState === 'destroyed') {
      windowPort.close();
      throw new Error('Cannot create a window on a destroyed BrowserHost.');
    }

    const lifecycle: BrowserWindowLifecycle = {
      closingFromPort: false,
      unsubscribeMetrics: () => undefined,
      unsubscribeClose: () => undefined
    };
    const windowOptions = withPortSurfaceTarget(options, windowPort.surfaceTarget);
    const hostWindow = new PlatformWindow(id, windowOptions, () => {
      lifecycle.unsubscribeMetrics();
      lifecycle.unsubscribeClose();
      if (!lifecycle.closingFromPort) {
        windowPort.close();
      }
    });
    lifecycle.unsubscribeMetrics = windowPort.onMetrics((update) => {
      hostWindow.queueMetrics(update);
    });
    lifecycle.unsubscribeClose = windowPort.onClose(() => {
      lifecycle.closingFromPort = true;
      try {
        hostWindow.close();
      } finally {
        lifecycle.closingFromPort = false;
      }
    });
    this.ownedWindows.push(hostWindow);
    return hostWindow;
  }

  createRunner(options: RunnerOptions): HostBoundaryRunner {
    this.assertActive('create a runner');
    if (options.kind !== 'browser') {
      throw new Error('BrowserHost only supports browser runners.');
    }
    return new HostBoundaryRunner(new BrowserRunner(this.port.animationFrames), () => {
      this.commitWindowFrameBoundary();
    });
  }

  windows(): readonly PlatformWindow[] {
    return Object.freeze([...this.ownedWindows]);
  }

  destroy(): void {
    if (this.currentState === 'destroyed') {
      return;
    }
    this.currentState = 'destroyed';
    for (const hostWindow of this.ownedWindows) {
      hostWindow.close();
    }
  }

  private assertActive(operation: string): void {
    if (this.currentState === 'destroyed') {
      throw new Error(`Cannot ${operation} on a destroyed BrowserHost.`);
    }
  }

  private commitWindowFrameBoundary(): void {
    for (const hostWindow of this.ownedWindows) {
      hostWindow.commitFrameBoundary();
    }
  }
}

function withPortSurfaceTarget(
  options: WindowOptions,
  surfaceTarget: SurfaceTarget | undefined
): WindowOptions {
  if (surfaceTarget === undefined) {
    return options;
  }
  return { ...options, surfaceTarget };
}

import type {
  BrowserPlatformPort,
  BrowserWindowPort,
  SurfaceTarget,
  WindowId,
  WindowMetricsUpdate,
  WindowOptions
} from '../../src';

export interface DOMCanvas {
  getBoundingClientRect(): Pick<DOMRectReadOnly, 'height' | 'width'>;
}

export interface DOMBrowserPortDependencies {
  readonly now: () => number;
  readonly requestAnimationFrame: (callback: (timestamp: number) => void) => number;
  readonly cancelAnimationFrame: (id: number) => void;
  readonly readLogicalSize: (canvas: DOMCanvas) => readonly [number, number];
  readonly readDevicePixelRatio: () => number;
  readonly observeResize: (canvas: DOMCanvas, listener: () => void) => () => void;
  readonly observeClose: (listener: () => void) => () => void;
}

export function createDOMBrowserPort(
  canvas: DOMCanvas,
  dependencyOverrides: Partial<DOMBrowserPortDependencies> = {}
): BrowserPlatformPort {
  const dependencies: DOMBrowserPortDependencies = {
    ...createDefaultDependencies(),
    ...dependencyOverrides
  };
  const surfaceTarget: SurfaceTarget = Object.freeze({
    id: Symbol('e2e-dom-canvas'),
    kind: 'canvas'
  });
  let activeWindow: DOMBrowserWindowPort | undefined;

  return {
    clock: Object.freeze({ now: dependencies.now }),
    animationFrames: Object.freeze({
      request: dependencies.requestAnimationFrame,
      cancel: dependencies.cancelAnimationFrame
    }),
    createWindow(_id: WindowId, _options: WindowOptions): BrowserWindowPort {
      if (activeWindow !== undefined) {
        throw new Error('The DOM browser port already owns an active window.');
      }
      const port = new DOMBrowserWindowPort(canvas, surfaceTarget, dependencies, () => {
        activeWindow = undefined;
      });
      activeWindow = port;
      return port;
    }
  };
}

class DOMBrowserWindowPort implements BrowserWindowPort {
  private readonly metricsListeners = new Set<(update: WindowMetricsUpdate) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly unsubscribeResize: () => void;
  private readonly unsubscribePlatformClose: () => void;
  private closed = false;

  constructor(
    private readonly canvas: DOMCanvas,
    readonly surfaceTarget: SurfaceTarget,
    private readonly dependencies: DOMBrowserPortDependencies,
    private readonly releaseOwnership: () => void
  ) {
    this.unsubscribeResize = dependencies.observeResize(canvas, () => {
      this.publishMetrics();
    });
    try {
      this.unsubscribePlatformClose = dependencies.observeClose(() => {
        this.closeFromPlatform();
      });
    } catch (setupError) {
      try {
        this.unsubscribeResize();
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          'DOM browser window observation setup and cleanup failed.'
        );
      }
      throw setupError;
    }
  }

  onMetrics(listener: (update: WindowMetricsUpdate) => void): () => void {
    if (this.closed) return () => undefined;
    this.metricsListeners.add(listener);
    return () => {
      this.metricsListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.finishClose(false);
  }

  private publishMetrics(): void {
    if (this.closed) return;
    const logicalSize = freezeSize(this.dependencies.readLogicalSize(this.canvas));
    const update: WindowMetricsUpdate = Object.freeze({
      logicalSize,
      devicePixelRatio: this.dependencies.readDevicePixelRatio()
    });
    for (const listener of [...this.metricsListeners]) {
      listener(update);
    }
  }

  private closeFromPlatform(): void {
    this.finishClose(true);
  }

  private finishClose(notifyListeners: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const closeListeners = notifyListeners ? [...this.closeListeners] : [];
    this.metricsListeners.clear();
    this.closeListeners.clear();
    this.releaseOwnership();

    const errors: unknown[] = [];
    for (const listener of closeListeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const unsubscribe of [this.unsubscribeResize, this.unsubscribePlatformClose]) {
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors);
  }
}

function createDefaultDependencies(): DOMBrowserPortDependencies {
  return {
    now: () => window.performance.now(),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
    readLogicalSize: (canvas) => {
      const rect = canvas.getBoundingClientRect();
      return [rect.width, rect.height];
    },
    readDevicePixelRatio: () => window.devicePixelRatio,
    observeResize: (canvas, listener) => {
      const observer = new ResizeObserver(listener);
      observer.observe(canvas as Element);
      window.addEventListener('resize', listener);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', listener);
      };
    },
    observeClose: (listener) => {
      window.addEventListener('pagehide', listener);
      return () => {
        window.removeEventListener('pagehide', listener);
      };
    }
  };
}

function freezeSize(size: readonly [number, number]): readonly [number, number] {
  return Object.freeze([size[0], size[1]]);
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `DOM browser window cleanup failed (${errors.length}).`);
  }
}

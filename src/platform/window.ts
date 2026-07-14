import { DEFAULT_WINDOW_TITLE } from './constants';
import type {
  HostWindow,
  SurfaceTarget,
  WindowId,
  WindowMetrics,
  WindowMetricsUpdate,
  WindowOptions,
  WindowState
} from './types';
import {
  createWindowMetrics,
  equalWindowMetrics,
  updateWindowMetrics
} from './window-metrics';

export class PlatformWindow implements HostWindow {
  readonly title: string;
  readonly surfaceTarget: SurfaceTarget | undefined;
  private currentMetrics: WindowMetrics;
  private pendingMetrics: WindowMetrics | undefined;
  private currentGeneration = 0;
  private currentState: WindowState = 'open';

  constructor(
    readonly id: WindowId,
    options: WindowOptions,
    private readonly onClose?: () => void
  ) {
    this.title = options.title ?? DEFAULT_WINDOW_TITLE;
    this.surfaceTarget = options.surfaceTarget;
    this.currentMetrics = createWindowMetrics(options);
  }

  get metrics(): WindowMetrics {
    return this.currentMetrics;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get state(): WindowState {
    return this.currentState;
  }

  get renderable(): boolean {
    return (
      this.currentState === 'open' &&
      this.currentMetrics.visible &&
      this.currentMetrics.physicalSize[0] > 0 &&
      this.currentMetrics.physicalSize[1] > 0
    );
  }

  queueMetrics(update: WindowMetricsUpdate): void {
    if (this.currentState === 'closed') {
      throw new Error(`Cannot update closed window ${this.id}.`);
    }
    this.pendingMetrics = updateWindowMetrics(
      this.pendingMetrics ?? this.currentMetrics,
      update
    );
  }

  commitFrameBoundary(): boolean {
    const pending = this.pendingMetrics;
    this.pendingMetrics = undefined;
    if (pending === undefined || equalWindowMetrics(this.currentMetrics, pending)) {
      return false;
    }
    // A resize/event burst becomes one observable version at the runner boundary.
    this.currentMetrics = pending;
    this.currentGeneration++;
    return true;
  }

  close(): void {
    if (this.currentState === 'closed') {
      return;
    }
    this.currentState = 'closed';
    this.pendingMetrics = undefined;
    this.onClose?.();
  }
}

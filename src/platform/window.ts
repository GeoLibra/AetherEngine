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
  private currentSurfaceTarget: SurfaceTarget | undefined;
  private pendingSurfaceTarget: SurfaceTarget | undefined;
  private hasPendingSurface = false;
  private currentMetrics: WindowMetrics;
  private pendingMetrics: WindowMetrics | undefined;
  private currentGeneration = 0;
  private currentState: WindowState = 'open';

  constructor(
    readonly id: WindowId,
    options: WindowOptions,
    private readonly onClose?: () => void,
    private readonly requiresSurfaceTarget = false
  ) {
    this.title = options.title ?? DEFAULT_WINDOW_TITLE;
    this.currentSurfaceTarget = options.surfaceTarget;
    this.currentMetrics = createWindowMetrics(options);
  }

  get metrics(): WindowMetrics {
    return this.currentMetrics;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get surfaceTarget(): SurfaceTarget | undefined { return this.currentSurfaceTarget; }

  get state(): WindowState {
    return this.currentState;
  }

  get renderable(): boolean {
    return (
      this.currentState === 'open' &&
      (!this.requiresSurfaceTarget || this.currentSurfaceTarget !== undefined) &&
      this.currentMetrics.visible &&
      this.currentMetrics.physicalSize[0] > 0 &&
      this.currentMetrics.physicalSize[1] > 0
    );
  }

  queueSurfaceTarget(target: SurfaceTarget | undefined): void {
    if (this.currentState === 'closed') {
      throw new Error(`Cannot update closed window ${this.id}.`);
    }
    this.pendingSurfaceTarget = target;
    this.hasPendingSurface = true;
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
    const metricsChanged = pending !== undefined && !equalWindowMetrics(this.currentMetrics, pending);
    const surfaceChanged = this.hasPendingSurface && this.pendingSurfaceTarget !== this.currentSurfaceTarget;
    if (metricsChanged) this.currentMetrics = pending;
    if (surfaceChanged) this.currentSurfaceTarget = this.pendingSurfaceTarget;
    this.pendingSurfaceTarget = undefined;
    this.hasPendingSurface = false;
    if (!metricsChanged && !surfaceChanged) return false;
    // A resize/event burst becomes one observable version at the runner boundary.
    this.currentGeneration++;
    return true;
  }

  close(): void {
    if (this.currentState === 'closed') {
      return;
    }
    this.currentState = 'closed';
    this.pendingMetrics = undefined;
    this.pendingSurfaceTarget = undefined;
    this.hasPendingSurface = false;
    this.onClose?.();
  }
}

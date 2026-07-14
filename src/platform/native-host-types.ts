import type { MonotonicClock } from '../core/clock';
import type {
  SurfaceTarget,
  WindowId,
  WindowMetricsUpdate,
  WindowOptions
} from './types';

export interface NativeFramePort {
  request(callback: (timestampSeconds: number) => void): number;
  cancel(id: number): void;
}

export interface NativeWindowPort {
  readonly surfaceTarget: SurfaceTarget | undefined;
  onMetrics(listener: (update: WindowMetricsUpdate) => void): () => void;
  onSurface(listener: (surface: SurfaceTarget | undefined) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface NativePlatformPort {
  readonly clock: MonotonicClock;
  readonly frames: NativeFramePort;
  createWindow(id: WindowId, options: WindowOptions): NativeWindowPort | Promise<NativeWindowPort>;
  pollEvents(): void;
  destroy(): void;
}

import type { MonotonicClock } from '../../core/clock';
import type { NativeMemoryPressureEvent } from '../../native-runtime/types';
import type { SurfaceTarget, WindowId, WindowMetricsUpdate, WindowOptions } from './platform-types';

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

export type NativePlatformLifecycleEvent =
  | Readonly<{ kind: 'foreground' | 'background' }>
  | Readonly<{ kind: 'audio-interruption'; interrupted: boolean }>
  | Readonly<{ kind: 'orientation'; orientation: string }>
  | Readonly<{ kind: 'resize'; size: readonly [number, number] }>
  | Readonly<{ kind: 'surface-lost' | 'surface-recreated'; generation: number }>
  | Readonly<{ kind: 'memory-pressure'; pressure: NativeMemoryPressureEvent }>;

export interface NativePlatformPort {
  readonly clock: MonotonicClock;
  readonly frames: NativeFramePort;
  createWindow(id: WindowId, options: WindowOptions): NativeWindowPort | Promise<NativeWindowPort>;
  pollEvents(): void;
  /** Lifecycle listeners must be invoked on the JS owner thread, normally while pollEvents runs. */
  onLifecycle?(listener: (event: NativePlatformLifecycleEvent) => void): () => void;
  destroy(): void;
}

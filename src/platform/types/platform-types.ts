import type { Runner } from '../../app/runner';
import type { MonotonicClock } from '../../core/clock';

/** Host execution environments supported by the portable platform boundary. */
export type HostKind = 'browser' | 'native' | 'headless';

declare const windowIdBrand: unique symbol;
export type WindowId = number & { readonly [windowIdBrand]: true };

export type WindowState = 'open' | 'closed';
export type HostState = 'active' | 'destroyed';

export interface WindowMetrics {
  readonly logicalSize: readonly [number, number];
  readonly physicalSize: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly visible: boolean;
  readonly focused: boolean;
}

/** Opaque presentation target identity. Backend-native handles stay adapter-owned. */
export interface SurfaceTarget {
  readonly id: symbol;
  readonly kind: 'canvas' | 'offscreen-canvas' | 'native-window' | 'offscreen';
}

export interface WindowOptions {
  readonly title?: string;
  readonly logicalSize: readonly [number, number];
  readonly devicePixelRatio?: number;
  readonly visible?: boolean;
  readonly focused?: boolean;
  readonly surfaceTarget?: SurfaceTarget;
}

export interface WindowMetricsUpdate {
  readonly logicalSize?: readonly [number, number];
  readonly devicePixelRatio?: number;
  readonly visible?: boolean;
  readonly focused?: boolean;
}

export interface HostWindow {
  readonly id: WindowId;
  readonly title: string;
  readonly metrics: WindowMetrics;
  readonly generation: number;
  readonly state: WindowState;
  readonly renderable: boolean;
  readonly surfaceTarget: SurfaceTarget | undefined;
  queueMetrics(update: WindowMetricsUpdate): void;
  commitFrameBoundary(): boolean;
  close(): void;
}

export type RunnerOptions =
  | {
      readonly kind: 'headless';
      readonly frames: number;
      readonly frameDelta?: number;
      readonly startTime?: number;
    }
  | { readonly kind: 'browser' }
  | { readonly kind: 'native' };

export interface PlatformServiceToken<T> {
  readonly key: symbol;
  readonly name: string;
  readonly __serviceType?: T;
}

export interface PlatformServiceEntry {
  readonly name: string;
  readonly token: PlatformServiceToken<unknown>;
}

export interface PlatformServiceRegistry {
  get<T>(token: PlatformServiceToken<T>): T;
  tryGet<T>(token: PlatformServiceToken<T>): T | undefined;
  list(): readonly PlatformServiceEntry[];
}

export interface Host {
  readonly kind: HostKind;
  readonly clock: MonotonicClock;
  readonly services: PlatformServiceRegistry;
  readonly state: HostState;
  createWindow(options: WindowOptions): Promise<HostWindow>;
  createRunner(options: RunnerOptions): Runner;
  windows(): readonly HostWindow[];
  destroy(): void | Promise<void>;
}

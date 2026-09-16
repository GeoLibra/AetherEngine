/**
 * Telemetry events and configuration for App runtime lifecycle and schedule observability.
 */

export type PluginLifecyclePhase = 'build' | 'prepare' | 'finish' | 'shutdown';

export type TelemetryEventKind =
  | 'plugin-start'
  | 'plugin-complete'
  | 'plugin-cancel'
  | 'plugin-fail'
  | 'schedule-compile-start'
  | 'schedule-compile-complete'
  | 'schedule-compile-fail'
  | 'system-span';

export interface BaseTelemetryEvent {
  readonly kind: TelemetryEventKind;
  readonly timestamp: number;
}

export interface PluginTelemetryEvent extends BaseTelemetryEvent {
  readonly kind: 'plugin-start' | 'plugin-complete' | 'plugin-cancel' | 'plugin-fail';
  readonly pluginId: string;
  readonly phase: PluginLifecyclePhase;
  readonly durationMs?: number | undefined;
  readonly error?: unknown | undefined;
}

export interface ScheduleCompileTelemetryEvent extends BaseTelemetryEvent {
  readonly kind: 'schedule-compile-start' | 'schedule-compile-complete' | 'schedule-compile-fail';
  readonly schedule: string;
  readonly durationMs?: number | undefined;
  readonly systemCount?: number | undefined;
  readonly error?: unknown | undefined;
}

export interface SystemSpanTelemetryEvent extends BaseTelemetryEvent {
  readonly kind: 'system-span';
  readonly schedule: string;
  readonly systemId: string;
  readonly durationMs: number;
}

export type AppTelemetryEvent =
  PluginTelemetryEvent | ScheduleCompileTelemetryEvent | SystemSpanTelemetryEvent;

export type TelemetryListener = (event: AppTelemetryEvent) => void;

export interface MonotonicClock {
  now(): number;
}

export interface AppTelemetryOptions {
  /** Enables lifecycle telemetry and schedule compilation tracking. */
  readonly enabled?: boolean;
  /** Enables high-frequency per-system span tracking. Disabled by default to avoid timer calls. */
  readonly recordSystemSpans?: boolean;
  /** Maximum number of events stored in the bounded circular buffer before oldest events are dropped. Default 1024. */
  readonly bufferCapacity?: number;
  /** Injected monotonic time source, e.g. for testing. */
  readonly clock?: MonotonicClock;
}

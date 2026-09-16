import type {
  AppTelemetryEvent,
  AppTelemetryOptions,
  MonotonicClock,
  PluginLifecyclePhase,
  TelemetryListener
} from './types';
import type { ScheduleTelemetrySpanRecorder } from './schedule';

const DEFAULT_BUFFER_CAPACITY = 1024;

const defaultClock: MonotonicClock = {
  now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }
};

/**
 * Optional runtime telemetry collector for App lifecycle, schedule compilation, and system spans.
 * Features bounded buffering, drop counters, and isolated subscriber callbacks.
 */
export class AppTelemetry implements ScheduleTelemetrySpanRecorder {
  private readonly enabled: boolean;
  private readonly recordSystemSpans: boolean;
  private readonly bufferCapacity: number;
  private readonly clock: MonotonicClock;
  private readonly buffer: AppTelemetryEvent[] = [];
  private readonly listeners = new Set<TelemetryListener>();
  private droppedCount = 0;

  constructor(options: AppTelemetryOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.recordSystemSpans = options.recordSystemSpans ?? false;
    this.bufferCapacity = Math.max(1, options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY);
    this.clock = options.clock ?? defaultClock;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get shouldRecordSystemSpans(): boolean {
    return this.enabled && this.recordSystemSpans;
  }

  get droppedEvents(): number {
    return this.droppedCount;
  }

  now(): number {
    if (!this.enabled) return 0;
    return this.clock.now();
  }

  subscribe(listener: TelemetryListener): () => boolean {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      return this.listeners.delete(listener);
    };
  }

  getEvents(): readonly AppTelemetryEvent[] {
    return Object.freeze([...this.buffer]);
  }

  clear(): void {
    this.buffer.length = 0;
    this.droppedCount = 0;
  }

  emit(event: AppTelemetryEvent): void {
    if (!this.enabled) return;

    if (this.buffer.length >= this.bufferCapacity) {
      this.buffer.shift();
      this.droppedCount++;
    }
    this.buffer.push(event);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber failure must not disrupt engine execution or replace runtime errors.
      }
    }
  }

  recordPluginStart(pluginId: string, phase: PluginLifecyclePhase): void {
    if (!this.enabled) return;
    this.emit({ kind: 'plugin-start', pluginId, phase, timestamp: this.now() });
  }

  recordPluginComplete(pluginId: string, phase: PluginLifecyclePhase, durationMs: number): void {
    if (!this.enabled) return;
    this.emit({ kind: 'plugin-complete', pluginId, phase, durationMs, timestamp: this.now() });
  }

  recordPluginCancel(pluginId: string, phase: PluginLifecyclePhase, durationMs?: number): void {
    if (!this.enabled) return;
    this.emit({ kind: 'plugin-cancel', pluginId, phase, durationMs, timestamp: this.now() });
  }

  recordPluginFail(
    pluginId: string,
    phase: PluginLifecyclePhase,
    durationMs: number,
    error: unknown
  ): void {
    if (!this.enabled) return;
    this.emit({ kind: 'plugin-fail', pluginId, phase, durationMs, error, timestamp: this.now() });
  }

  recordScheduleCompileStart(schedule: string): void {
    if (!this.enabled) return;
    this.emit({ kind: 'schedule-compile-start', schedule, timestamp: this.now() });
  }

  recordScheduleCompileComplete(schedule: string, durationMs: number, systemCount: number): void {
    if (!this.enabled) return;
    this.emit({
      kind: 'schedule-compile-complete',
      schedule,
      durationMs,
      systemCount,
      timestamp: this.now()
    });
  }

  recordScheduleCompileFail(schedule: string, durationMs: number, error: unknown): void {
    if (!this.enabled) return;
    this.emit({
      kind: 'schedule-compile-fail',
      schedule,
      durationMs,
      error,
      timestamp: this.now()
    });
  }

  recordSpan(schedule: string, systemId: string, durationMs: number): void {
    if (!this.shouldRecordSystemSpans) return;
    this.emit({ kind: 'system-span', schedule, systemId, durationMs, timestamp: this.now() });
  }
}

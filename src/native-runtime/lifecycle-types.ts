export type NativeBackgroundDomainPolicy = 'pause' | 'continue';

export interface NativeBackgroundPolicy {
  readonly simulation: NativeBackgroundDomainPolicy;
  readonly render: NativeBackgroundDomainPolicy;
  readonly audio: NativeBackgroundDomainPolicy;
}

export type NativeLifecycleSnapshot = Readonly<{
  kind:
    | 'foreground' | 'background' | 'audio-interruption' | 'orientation'
    | 'resize' | 'surface-lost' | 'surface-recreated';
  policy?: NativeBackgroundPolicy;
  interrupted?: boolean;
  orientation?: string;
  size?: readonly [number, number];
  generation?: number;
}>;

export interface NativeMemoryPressureEvent {
  readonly severity: 'moderate' | 'critical';
  readonly targetBytes: number;
  readonly maxCallbacks: number;
}

export interface NativeMemoryEvictor {
  readonly name: string;
  readonly priority: number;
  evict(budgetBytes: number): number;
}

export interface NativeMemoryPressureResult {
  readonly requestedBytes: number;
  readonly evictedBytes: number;
  readonly sufficient: boolean;
  readonly callbacks: number;
  readonly failedEvictors: readonly string[];
}

export interface NativeCrashReportInput {
  readonly jsException: string;
  readonly nativeStack: string;
  readonly device: Readonly<Record<string, unknown>>;
  readonly recentTelemetry: readonly unknown[];
}

export interface NativeCrashReportOptions {
  readonly telemetryLimit: number;
  readonly maxStringLength: number;
}

export interface NativeCrashReport {
  readonly jsException: string;
  readonly nativeStack: string;
  readonly device: unknown;
  readonly recentTelemetry: readonly unknown[];
}

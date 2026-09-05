/** Graphics backends supported by the browser Doctor probe, in preference order. */
export type DoctorBackend = 'webgpu' | 'webgl2';

/** Terminal outcome of the complete preferred-backend and fallback probe sequence. */
export type DoctorVerdict =
  'verified' | 'verified-with-fallback' | 'failed' | 'unverified' | 'unsupported';

/** Terminal outcome of one backend probe before preference-order aggregation. */
export type DoctorBackendStatus = 'verified' | 'failed' | 'unverified' | 'unsupported';

/** Observable result of one diagnostic stage. */
export type DoctorStageStatus = 'passed' | 'failed' | 'info' | 'skipped';

/** One observable checkpoint in an actual graphics probe. */
export interface DoctorStageResult {
  readonly name: string;
  readonly status: DoctorStageStatus;
  readonly message?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Result for one requested graphics backend. */
export interface DoctorBackendResult {
  readonly backend: DoctorBackend;
  readonly status: DoctorBackendStatus;
  readonly stages: readonly DoctorStageResult[];
}

/** Immutable terminal report produced by an Aether Doctor run. */
export interface DoctorReport {
  readonly verdict: DoctorVerdict;
  readonly durationMs: number;
  readonly backends: readonly DoctorBackendResult[];
}

/** Structural evidence derived from an RGBA8 canvas capture. */
export interface PixelReadbackInspection {
  readonly byteLength: number;
  readonly checksum: string;
  readonly opaquePixels: number;
  readonly distinctColors: number;
  readonly verified: boolean;
}

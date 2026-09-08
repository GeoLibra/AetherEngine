import type { BackgroundDiagnosticCode } from './types';

export const BackgroundDiagnosticCodes = Object.freeze({
  EnvironmentMissing: 'background-environment-missing',
  PanoramaUnavailable: 'background-panorama-unavailable',
  SchemaUnsupported: 'background-schema-unsupported',
  CapabilityUnsupported: 'background-capability-unsupported',
  ProjectionInvalid: 'background-projection-invalid',
  CompositionInvalid: 'background-composition-invalid',
  UploadFailed: 'background-upload-failed',
  StaleResult: 'background-stale-result'
} as const);

export class BackgroundDiagnosticError extends Error {
  readonly code: BackgroundDiagnosticCode;
  readonly viewId?: string | undefined;
  readonly stage?: string | undefined;

  constructor(
    code: BackgroundDiagnosticCode,
    message: string,
    options?: { viewId?: string; stage?: string }
  ) {
    super(`[${code}] ${message}${options?.viewId ? ` (view: ${options.viewId})` : ''}`);
    this.name = 'BackgroundDiagnosticError';
    this.code = code;
    this.viewId = options?.viewId;
    this.stage = options?.stage;
  }
}

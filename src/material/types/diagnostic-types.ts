/** Diagnostic codes emitted during material parameter editing and schema validation. */
export type MaterialEditDiagnosticCode =
  | 'unknown-field'
  | 'type-mismatch'
  | 'schema-mismatch'
  | 'stale-field'
  | 'duplicate-field'
  | 'invalid-alias'
  | 'incompatible-asset';

/** Diagnostic codes emitted during shader and resource binding compatibility checks. */
export type MaterialBindingDiagnosticCode =
  | 'missing-resource'
  | 'resource-not-ready'
  | 'binding-kind-mismatch'
  | 'texture-dimension-mismatch'
  | 'texture-sample-type-mismatch'
  | 'texture-multisample-mismatch'
  | 'sampler-type-mismatch'
  | 'device-generation-mismatch';

/** Diagnostic codes emitted during technique selection and render-state resolution. */
export type MaterialTechniqueDiagnosticCode =
  | 'no-compatible-technique'
  | 'undeclared-fallback'
  | 'render-state-conflict'
  | 'missing-binding'
  | 'compile-failure';

/** Aggregate union of all diagnostic codes emitted by the material subsystem. */
export type MaterialDiagnosticCode =
  MaterialEditDiagnosticCode | MaterialBindingDiagnosticCode | MaterialTechniqueDiagnosticCode;

/** Structured diagnostic record produced by material operations. */
export interface MaterialDiagnostic {
  readonly code: MaterialDiagnosticCode;
  readonly materialId?: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly field?: string;
  readonly message: string;
}

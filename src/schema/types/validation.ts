/**
 * Diagnostic issue produced when a payload or field fails schema validation.
 */
export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Result of validating an arbitrary input against a schema validator.
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

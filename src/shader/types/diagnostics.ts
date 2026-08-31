export interface SourceSpan {
  readonly uri: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export interface ShaderDiagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly stage:
    | 'resolve'
    | 'parse'
    | 'typecheck'
    | 'layout'
    | 'capability'
    | 'emit'
    | 'backend-validation'
    | 'cache';
  readonly primary: SourceSpan;
  readonly related: readonly SourceSpan[];
  readonly backendLog?: string;
}

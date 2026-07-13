export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticSource {
  readonly uri: string;
  readonly line?: number;
  readonly column?: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly subsystem: string;
  readonly source?: DiagnosticSource;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface DiagnosticQuery {
  readonly code?: string;
  readonly severity?: DiagnosticSeverity;
  readonly subsystem?: string;
}

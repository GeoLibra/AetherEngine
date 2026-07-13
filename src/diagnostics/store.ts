import { cloneUnknown, freezeUnknown } from '../schema/migration';
import type { Diagnostic, DiagnosticQuery } from './types';

const DEFAULT_DIAGNOSTIC_CAPACITY = 1_024;

export class DiagnosticStore {
  private readonly records: Diagnostic[] = [];
  private droppedRecords = 0;

  constructor(readonly capacity = DEFAULT_DIAGNOSTIC_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('DiagnosticStore capacity must be a positive integer.');
    }
  }

  get dropped(): number {
    return this.droppedRecords;
  }

  emit(diagnostic: Diagnostic): void {
    validateDiagnostic(diagnostic);
    if (this.records.length === this.capacity) {
      this.records.shift();
      this.droppedRecords++;
    }
    this.records.push(snapshotDiagnostic(diagnostic));
  }

  list(query: DiagnosticQuery = {}): readonly Diagnostic[] {
    return Object.freeze(
      this.records.filter(
        (entry) =>
          (query.code === undefined || entry.code === query.code) &&
          (query.severity === undefined || entry.severity === query.severity) &&
          (query.subsystem === undefined || entry.subsystem === query.subsystem)
      )
    );
  }

  clear(): void {
    this.records.length = 0;
  }
}

function snapshotDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return Object.freeze({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    subsystem: diagnostic.subsystem,
    ...(diagnostic.source === undefined
      ? {}
      : { source: Object.freeze({ ...diagnostic.source }) }),
    ...(diagnostic.context === undefined
      ? {}
      : {
          context: freezeUnknown(
            cloneUnknown(diagnostic.context) as Record<string, unknown>
          )
        }),
    ...(diagnostic.cause === undefined ? {} : { cause: snapshotCause(diagnostic.cause) })
  });
}

function snapshotCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return Object.freeze({ name: cause.name, message: cause.message });
  }
  try {
    return freezeUnknown(cloneUnknown(cause));
  } catch {
    return Object.freeze({ description: String(cause) });
  }
}

function validateDiagnostic(diagnostic: Diagnostic): void {
  if (
    diagnostic.code.trim() === '' ||
    diagnostic.message.trim() === '' ||
    diagnostic.subsystem.trim() === ''
  ) {
    throw new Error('Diagnostic code, message, and subsystem must not be empty.');
  }
}

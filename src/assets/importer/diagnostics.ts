import type { AssetDiagnostic, AssetDiagnosticSink } from './types';

/**
 * Standard in-memory sink for collecting diagnostics during asset import.
 */
export class InMemoryDiagnosticSink implements AssetDiagnosticSink {
  private readonly items: AssetDiagnostic[] = [];

  report(diagnostic: AssetDiagnostic): void {
    this.items.push(Object.freeze({ ...diagnostic }));
  }

  getDiagnostics(): readonly AssetDiagnostic[] {
    return Object.freeze([...this.items]);
  }

  hasErrors(): boolean {
    return this.items.some((item) => item.severity === 'error');
  }
}

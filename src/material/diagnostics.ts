import type { MaterialDiagnostic } from './types';

export class MaterialDiagnosticError extends Error {
  readonly diagnostic: Readonly<MaterialDiagnostic>;

  constructor(diagnostic: MaterialDiagnostic) {
    super(diagnostic.message);
    this.name = 'MaterialDiagnosticError';
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

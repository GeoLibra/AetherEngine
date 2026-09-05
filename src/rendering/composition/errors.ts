import type { CompositionDiagnosticCode } from './types';

/** Typed composition contract failure with the relevant slot and surface identities. */
export class CompositionPlanError extends Error {
  constructor(
    readonly code: CompositionDiagnosticCode,
    message: string,
    readonly slotId?: string,
    readonly surfaceId?: string
  ) {
    super(message);
    this.name = 'CompositionPlanError';
  }
}

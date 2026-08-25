import type { RenderEntityId } from '../../world';
import type { RenderPhaseKind } from './render-phase-types';
import type { PreparedDrawPacket } from './prepared-draw-packet-types';

export type PreparedDrawPhaseSkipCode =
  'draw-phase-mismatch' | 'released-draw-packet' | 'duplicate-draw-association';

/** Structured rejection produced while assembling a prepared draw phase. */
export interface PreparedDrawPhaseSkip {
  readonly entity: RenderEntityId;
  readonly reason: 'incompatible-prepared-draw-phase';
  readonly code: PreparedDrawPhaseSkipCode;
  readonly message: string;
}

/** Immutable ordered packet snapshot for one view and render phase. */
export interface PreparedDrawPhaseSnapshot {
  readonly viewId: string;
  readonly phase: RenderPhaseKind;
  readonly packets: readonly PreparedDrawPacket[];
}

/** Prepared phase output plus packet-level compatibility diagnostics. */
export interface PreparedDrawPhaseResult {
  readonly snapshot: PreparedDrawPhaseSnapshot;
  readonly skipped: readonly PreparedDrawPhaseSkip[];
}

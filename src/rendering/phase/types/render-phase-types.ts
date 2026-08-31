import type { MaterialPipelineCompatibilitySkip } from '../../material/types';
import type { MeshQueueSkip } from '../../mesh/types';
import type { RenderEntityId } from '../../world';

export type RenderPhaseKind = 'shadow' | 'opaque' | 'alpha-test' | 'transparent' | 'overlay';

/**
 * A single draw candidate recorded for a specific camera view.
 */
export interface PhaseItem {
  readonly entity: RenderEntityId;
  readonly phase: RenderPhaseKind;
  readonly pipelineKey: string;
  readonly materialKey: string;
  readonly meshKey: string;
  readonly bindingKey?: string;
  readonly drawKey: string;
  readonly distance: number; // View-space depth distance from the camera
  readonly insertionOrder: number;
}

/**
 * A group of compatible PhaseItems that can be merged into a single multi-draw or instanced call.
 */
export interface PhaseBatch {
  readonly compatibilityKey: string;
  readonly items: readonly PhaseItem[];
}

/**
 * A snapshot of all visible items and batches associated with a specific camera view and phase.
 */
export interface RenderPhaseSnapshot {
  readonly viewId: string;
  readonly phase: RenderPhaseKind;
  readonly items: readonly PhaseItem[];
  readonly batches: readonly PhaseBatch[];
}

/** Renderer-owned immutable facts used to construct one view-scoped phase. */
export interface RenderPhaseConstructionContext {
  readonly viewId: string;
  readonly phase: RenderPhaseKind;
  readonly insertionOrderOrigin?: number;
}

/** Closed reasons for rejecting a resolved candidate at the phase boundary. */
export type RenderPhaseConstructionSkipCode =
  'incompatible-phase-surface' | 'invalid-borrowed-candidate' | 'invalid-phase-context';

/** One candidate rejected without changing ownership of its prepared leases. */
export interface RenderPhaseConstructionSkip {
  readonly entity: RenderEntityId;
  readonly reason: 'incompatible-render-phase';
  readonly code: RenderPhaseConstructionSkipCode;
  readonly message: string;
}

/** Diagnostics accepted from upstream queue and Material compatibility boundaries. */
export type RenderPhaseUpstreamSkip = MeshQueueSkip | MaterialPipelineCompatibilitySkip;

/** Immutable phase snapshot plus all upstream and local typed skips. */
export interface RenderPhaseConstructionResult {
  readonly snapshot: RenderPhaseSnapshot;
  readonly skipped: readonly (RenderPhaseUpstreamSkip | RenderPhaseConstructionSkip)[];
}

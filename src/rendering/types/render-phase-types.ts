import type { MaterialPipelineCompatibilitySkip } from './material-pipeline-compatibility-types';
import type { MeshQueueSkip } from './mesh-queue-types';
import type { RenderEntityId } from '../render-world';
import type { RenderPhaseKind, RenderPhaseSnapshot } from '../render-phase';

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

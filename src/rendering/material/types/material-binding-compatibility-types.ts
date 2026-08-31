import type { MaterialDiagnostic, MaterialParameterBlock } from '../../../material';
import type { CompiledMaterialBindingLayout, MaterialResourceResolver } from '../material-bindings';
import type { CanonicalKey, BindingKeyParts, BindingLayoutPlan } from '../../pipeline/types';
import type { PhaseItem, RenderPhaseSnapshot } from '../../phase/types';
import type { ResolvedMaterialPipelineCandidate } from './material-pipeline-compatibility-types';

/** Upload-allocation identity supplied without allocating or uploading resources. */
export interface BindingAllocationFacts {
  readonly bufferAllocationGeneration: number;
  readonly ringGeneration: number;
  readonly dynamicOffsets: readonly number[];
  readonly deviceGeneration: number;
}

/** Exact association required to bind one unbound phase item. */
export interface MaterialBindingCompatibilityRequest {
  readonly item: PhaseItem;
  readonly candidate: ResolvedMaterialPipelineCandidate;
  readonly layout: CompiledMaterialBindingLayout;
  readonly bindingPlan: BindingLayoutPlan;
  readonly supplied: MaterialParameterBlock;
  readonly defaults?: MaterialParameterBlock;
  readonly resolver: MaterialResourceResolver;
  readonly allocation: BindingAllocationFacts;
}

export type MaterialBindingCompatibilitySkipCode =
  | 'binding-layout-incompatible'
  | 'binding-resource-missing'
  | 'binding-resource-not-ready'
  | 'binding-device-generation-stale'
  | 'binding-allocation-invalid';

/** Expected Queue rejection with original Material diagnostics preserved. */
export interface MaterialBindingCompatibilitySkip {
  readonly entity: PhaseItem['entity'];
  readonly reason: 'incompatible-binding';
  readonly code: MaterialBindingCompatibilitySkipCode;
  readonly diagnostics: readonly MaterialDiagnostic[];
}

/** Successfully bound immutable phase item and its full canonical key. */
export interface BoundMaterialPhaseItem {
  readonly item: PhaseItem & { readonly bindingKey: string };
  readonly bindingKey: CanonicalKey<BindingKeyParts>;
  readonly diagnostics: readonly MaterialDiagnostic[];
}

/** Immutable binding resolution output used by later pipeline/cache work. */
export interface MaterialBindingCompatibilityResult {
  readonly snapshot: RenderPhaseSnapshot;
  readonly bound: readonly BoundMaterialPhaseItem[];
  readonly skipped: readonly MaterialBindingCompatibilitySkip[];
}

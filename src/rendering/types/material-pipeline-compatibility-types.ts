import type {
  MaterialAsset,
  MaterialTechniqueRole,
  MaterialTechniqueSelection
} from '../../material';
import type { CanonicalKey, PipelineKeyParts } from '../pipeline-resolver';
import type { ResolvedMaterialRenderState } from '../../material/render-state';
import type { RenderPhaseKind } from '../render-phase';
import type { PreparedMeshQueueCandidate } from './mesh-queue-types';

/** Immutable Material-owned facts published before Queue compatibility resolution. */
export interface PreparedMaterialCompatibility {
  readonly deviceGeneration: number;
  readonly asset: MaterialAsset;
  readonly bindingLayoutHash: string;
  readonly selectedVariant: string;
  readonly availableMaterialFeatures: readonly string[];
}

/** Renderer-owned view and pass facts required to select one executable pipeline identity. */
export interface MaterialPipelineContext {
  readonly phase: RenderPhaseKind;
  readonly allowedRoles: readonly MaterialTechniqueRole[];
  readonly availableFeatures: readonly string[];
  readonly availableMeshCapabilities: readonly string[];
  readonly availableViewFeatures: readonly string[];
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly semanticTag: string;
  readonly featurePolicyHash: string;
  readonly deviceGeneration: number;
}

/** Closed reasons for rejecting a prepared candidate before RenderPhase construction. */
export type MaterialPipelineCompatibilitySkipCode =
  | 'invalid-material-payload'
  | 'device-generation-stale'
  | 'layout-incompatible'
  | 'variant-unsupported'
  | 'render-state-conflict';

/** Structured diagnostic retained for Queue inspection and aggregation. */
export interface MaterialPipelineCompatibilityDiagnostic {
  readonly code: MaterialPipelineCompatibilitySkipCode;
  readonly message: string;
  readonly materialId?: string;
  readonly technique?: string;
}

/** One candidate rejected by compatibility resolution without releasing its borrowed leases. */
export interface MaterialPipelineCompatibilitySkip {
  readonly entity: PreparedMeshQueueCandidate['entity'];
  readonly reason: 'incompatible-pipeline';
  readonly code: MaterialPipelineCompatibilitySkipCode;
  readonly diagnostic: Readonly<MaterialPipelineCompatibilityDiagnostic>;
}

/** One candidate with a selected technique, portable fixed state, and canonical pipeline key. */
export interface ResolvedMaterialPipelineCandidate {
  readonly candidate: PreparedMeshQueueCandidate;
  readonly selection: Exclude<MaterialTechniqueSelection, { readonly status: 'unsupported' }>;
  readonly renderState: Extract<ResolvedMaterialRenderState, { readonly status: 'resolved' }>;
  readonly pipelineKey: CanonicalKey<PipelineKeyParts>;
}

/** Immutable compatibility resolution output consumed by a later RenderPhase task. */
export interface MaterialPipelineCompatibilityResult {
  readonly resolved: readonly ResolvedMaterialPipelineCandidate[];
  readonly skipped: readonly MaterialPipelineCompatibilitySkip[];
}

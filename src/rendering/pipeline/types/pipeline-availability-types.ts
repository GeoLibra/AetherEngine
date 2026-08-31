import type { RHIRenderPipeline } from '../../../rhi/contracts';
import type { BoundMaterialPhaseItem } from '../../material/types';
import type {
  PipelineCacheEntryState,
  PipelineCompileDiagnostic,
  PipelineReadyLease
} from './pipeline-cache-types';
import type { RenderPhaseKind } from '../../phase/types';

/** Complete compatibility facts required before a fallback pipeline can replace a primary. */
export interface PipelineAvailabilityIdentity {
  readonly phase: RenderPhaseKind;
  readonly semanticTag: string;
  readonly bindingLayoutHash: string;
  readonly vertexLayoutHash: string;
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly featurePolicyHash: string;
  readonly backendTarget: string;
  readonly deviceGeneration: number;
}

/** Declared fallback state and the identity it promises to preserve. */
export interface PipelineAvailabilityFallback {
  readonly identity: PipelineAvailabilityIdentity;
  readonly state: PipelineCacheEntryState;
  readonly lease?: PipelineReadyLease;
}

/** Queue facts resolved synchronously without access to the compiler. */
export interface PipelineAvailabilityRequest {
  readonly bound: BoundMaterialPhaseItem;
  readonly identity: PipelineAvailabilityIdentity;
  readonly primary: PipelineCacheEntryState;
  readonly primaryLease?: PipelineReadyLease;
  readonly fallback?: PipelineAvailabilityFallback;
}

export type PipelineAvailabilitySkipCode =
  'pipeline-compiling' | 'pipeline-error' | 'device-generation-stale' | 'fallback-incompatible';

/** Ready pipeline selected for one already-bound phase item. */
export interface AvailablePipelinePhaseItem {
  readonly status: 'ready';
  readonly bound: BoundMaterialPhaseItem;
  readonly pipeline: RHIRenderPipeline;
  readonly pipelineLease: PipelineReadyLease;
  readonly selection: 'primary' | 'fallback';
}

/** Expected Queue rejection caused by pipeline availability. */
export interface PipelineAvailabilitySkip {
  readonly status: 'skipped';
  readonly entity: BoundMaterialPhaseItem['item']['entity'];
  readonly reason: 'pipeline-unavailable';
  readonly code: PipelineAvailabilitySkipCode;
  readonly diagnostic?: PipelineCompileDiagnostic;
}

export type PipelineAvailabilityResult = AvailablePipelinePhaseItem | PipelineAvailabilitySkip;

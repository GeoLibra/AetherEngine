import type { RHIRenderPipeline } from '../../rhi/contracts';

/** Stable facts that identify one asynchronous pipeline compile request. */
export interface PipelineCompileRequest {
  readonly pipelineKey: string;
  readonly requestRevision: number;
  readonly shaderRevision: number;
  readonly layoutRevision: number;
  readonly featurePolicyHash: string;
  readonly deviceGeneration: number;
}

/** Bounded diagnostic retained for a content-addressed compile failure. */
export interface PipelineCompileDiagnostic {
  readonly code: string;
  readonly message: string;
}

/** Reason an entry can no longer publish or serve its pipeline. */
export type PipelineInvalidationReason =
  | 'request-revision-changed'
  | 'shader-revision-changed'
  | 'layout-revision-changed'
  | 'feature-policy-changed'
  | 'device-generation-changed';

/** Immutable state exposed to Queue without waiting for compilation. */
export type PipelineCacheEntryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'queued'; readonly requestId: string }
  | { readonly kind: 'compiling'; readonly requestId: string; readonly startedAt: number }
  | {
      readonly kind: 'ready';
      readonly pipeline: RHIRenderPipeline;
      readonly deviceGeneration: number;
    }
  | {
      readonly kind: 'errored';
      readonly diagnostic: PipelineCompileDiagnostic;
      readonly retry: 'input-change';
    }
  | { readonly kind: 'stale'; readonly reason: PipelineInvalidationReason };

/** Successful compiler output. Cleanup is used when completion becomes stale before publication. */
export interface PipelineCompileSuccess {
  readonly status: 'success';
  readonly pipeline: RHIRenderPipeline;
  readonly disposeUnpublished?: () => void;
}

/** Expected compiler failure suitable for content-addressed error caching. */
export interface PipelineCompileFailure {
  readonly status: 'error';
  readonly diagnostic: PipelineCompileDiagnostic;
}

export type PipelineCompileOutcome = PipelineCompileSuccess | PipelineCompileFailure;

/** Asynchronous creation port owned by the renderer/device integration layer. */
export interface PipelineCompiler {
  compile(request: PipelineCompileRequest): Promise<PipelineCompileOutcome>;
}

/** Immutable Queue-facing lookup result for one canonical pipeline key. */
export interface PipelineCacheSnapshot {
  readonly pipelineKey: string;
  readonly state: PipelineCacheEntryState;
}

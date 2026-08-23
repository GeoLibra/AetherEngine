import type { RHIRenderPipelineDescriptor } from '../../rhi/contracts';
import type { PipelineCompileRequest } from './pipeline-cache-types';

/** Immutable render-pipeline creation input associated with one exact canonical key identity. */
export interface PreparedRenderPipelineArtifact {
  readonly request: PipelineCompileRequest;
  readonly descriptor: Readonly<RHIRenderPipelineDescriptor>;
}

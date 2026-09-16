import type {
  DeclaredColorAttachment,
  DeclaredDepthStencilAttachment,
  DeclaredResolveAttachment
} from './typed-pass-types';
import type {
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from './prepared-resource-types';

export interface RasterPassDeclarationDetails {
  readonly colorAttachments: readonly DeclaredColorAttachment[];
  readonly depthStencilAttachment?: DeclaredDepthStencilAttachment | undefined;
  readonly resolveAttachments: readonly DeclaredResolveAttachment[];
  readonly preparedRenderPipelines: readonly PreparedRenderPipelineToken[];
  readonly preparedDrawResources: readonly PreparedDrawResourcesToken[];
}

export interface ComputePassDeclarationDetails {
  readonly preparedComputePipelines: readonly PreparedComputePipelineToken[];
}

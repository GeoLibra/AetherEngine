import type {
  RHIBindGroupLayout,
  RHIComputePipeline,
  RHIRenderPipeline
} from '../../rhi/contracts';
import type { PreparedDrawPacket } from '../../rendering/phase';

/** Valid resource kinds for prepared resources registered before graph execution. */
export type PreparedResourceKind =
  'compute-pipeline' | 'bind-group-layout' | 'render-pipeline' | 'draw-resources';

/** Generic typed key for a resource created before graph surface acquisition. */
export interface PreparedToken<K extends PreparedResourceKind = PreparedResourceKind> {
  readonly kind: `prepared-${K}-token`;
  readonly name: string;
  readonly id: symbol;
}

/** Typed key for a compute pipeline created before graph surface acquisition. */
export type PreparedComputePipelineToken = PreparedToken<'compute-pipeline'>;

export type PreparedComputePipelineBindings = ReadonlyMap<
  PreparedComputePipelineToken,
  RHIComputePipeline
>;

/** Typed key for a bind-group layout created before graph surface acquisition. */
export type PreparedBindGroupLayoutToken = PreparedToken<'bind-group-layout'>;

export type PreparedBindGroupLayoutBindings = ReadonlyMap<
  PreparedBindGroupLayoutToken,
  RHIBindGroupLayout
>;

/** Typed key for a render pipeline created before graph surface acquisition. */
export type PreparedRenderPipelineToken = PreparedToken<'render-pipeline'>;

export type PreparedRenderPipelineBindings = ReadonlyMap<
  PreparedRenderPipelineToken,
  RHIRenderPipeline
>;

/** Typed key for prepared draw packet resources created before graph surface acquisition. */
export type PreparedDrawResourcesToken = PreparedToken<'draw-resources'>;

export type PreparedDrawResourcesBindings = ReadonlyMap<
  PreparedDrawResourcesToken,
  PreparedDrawPacket
>;

import type {
  BufferHandle,
  PreparedBindGroupLayoutToken,
  PreparedDrawResourceBindings,
  RenderSystemDescriptor,
  SurfaceFrameToken,
  TextureDescriptor
} from '../../../render-graph';
import type { WebGlFragmentLightListBuildOutput, WebGpuLightListBuildOutput } from '../../lighting';
import type { PreparedDrawPhaseSnapshot } from './prepared-draw-phase-types';

/** Static graph and prepared-resource inputs for one opaque view system. */
export interface OpaqueRenderSystemInput {
  readonly id?: string;
  readonly phase: PreparedDrawPhaseSnapshot;
  readonly surfaceFrame: SurfaceFrameToken;
  readonly color: TextureDescriptor;
  readonly depth: TextureDescriptor;
  readonly lightList?: OpaqueLightListInput;
  readonly environment?: Readonly<{
    buffer: BufferHandle;
    irradianceMap: import('../../../render-graph').TextureHandle;
    prefilteredRadianceMap: import('../../../render-graph').TextureHandle;
    environmentBrdfLut: import('../../../render-graph').TextureHandle;
  }>;
  readonly colorTarget?: import('../../../render-graph').TextureHandle;
  readonly present?: boolean;
  readonly publishColor?: (color: import('../../../render-graph').TextureHandle) => void;
}

/** Backend-specific LightList resources consumed by the standard forward group at index three. */
export type OpaqueLightListInput =
  | Readonly<{
      source: 'gpu-compute';
      packedLights: BufferHandle;
      output: WebGpuLightListBuildOutput;
      bindGroupLayout: PreparedBindGroupLayoutToken;
    }>
  | Readonly<{
      source: 'webgl-fragment';
      packedLights: import('../../../render-graph').TextureHandle;
      output: WebGlFragmentLightListBuildOutput;
      bindGroupLayout: PreparedBindGroupLayoutToken;
    }>;

/** RenderSystem contribution plus the exact packet bindings required at execution. */
export interface OpaqueRenderSystemPreparation {
  readonly descriptor: RenderSystemDescriptor<unknown>;
  readonly preparedDrawResources: PreparedDrawResourceBindings;
}

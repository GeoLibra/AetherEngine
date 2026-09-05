import type {
  BufferHandle,
  PreparedComputePipelineToken,
  PreparedRenderPipelineToken,
  RenderGraphBuilder,
  RestrictedPassContext,
  TextureHandle
} from '../../../render-graph';
import type { CpuLightListCapacity } from './light-list';

/** GPU buffer inputs already packed for the WebGPU light-list compute pass. */
export interface WebGpuLightListBuildInput {
  readonly lights: BufferHandle;
  readonly receivers: BufferHandle;
  readonly receiverCount: number;
}

/** Storage outputs produced by the WebGPU implementation for later shading passes. */
export interface WebGpuLightListBuildOutput {
  readonly source: 'gpu-compute';
  readonly directionalIndices: BufferHandle;
  readonly headers: BufferHandle;
  readonly lightIndices: BufferHandle;
  readonly overflow: BufferHandle;
  readonly capacity: CpuLightListCapacity;
}

/** Records the backend-prepared compute pipeline and bindings inside the declared graph pass. */
export interface WebGpuLightListBuildRecorder {
  readonly pipeline: PreparedComputePipelineToken;
  record(
    context: RestrictedPassContext,
    input: WebGpuLightListBuildInput,
    output: WebGpuLightListBuildOutput
  ): void;
}

/** Build-time context supplied after FeaturePolicy selects the WebGPU implementation. */
export interface WebGpuLightListBuildContext {
  readonly graph: RenderGraphBuilder;
  readonly viewId: string;
  readonly input: WebGpuLightListBuildInput;
  readonly recorder: WebGpuLightListBuildRecorder;
  publish(output: WebGpuLightListBuildOutput): void;
}

/** Texture inputs packed according to the cooked WebGL2 fragment implementation manifest. */
export interface WebGlFragmentLightListBuildInput {
  readonly lights: TextureHandle;
  readonly receivers: TextureHandle;
  readonly receiverCount: number;
}

/** Integer render-target outputs sampled by later WebGL2 shading passes. */
export interface WebGlFragmentLightListBuildOutput {
  readonly source: 'webgl-fragment';
  readonly directionalIndices: TextureHandle;
  readonly headers: TextureHandle;
  readonly lightIndices: TextureHandle;
  readonly overflow: TextureHandle;
  readonly capacity: CpuLightListCapacity;
  readonly packing: WebGlLightListPacking;
}

/** Shared integer-MRT extent and row layout consumed by WebGL2 shading passes. */
export interface WebGlLightListPacking {
  readonly width: number;
  readonly height: number;
  readonly indexRows: number;
  readonly receiverRows: number;
}

/** Records the backend-prepared fullscreen fragment pipeline and bindings. */
export interface WebGlFragmentLightListBuildRecorder {
  readonly pipeline: PreparedRenderPipelineToken;
  record(
    context: RestrictedPassContext,
    input: WebGlFragmentLightListBuildInput,
    output: WebGlFragmentLightListBuildOutput
  ): void;
}

/** Build-time context supplied after FeaturePolicy selects the WebGL2 implementation. */
export interface WebGlFragmentLightListBuildContext {
  readonly graph: RenderGraphBuilder;
  readonly viewId: string;
  readonly input: WebGlFragmentLightListBuildInput;
  readonly recorder: WebGlFragmentLightListBuildRecorder;
  publish(output: WebGlFragmentLightListBuildOutput): void;
}

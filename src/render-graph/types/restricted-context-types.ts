import type {
  GPUColor,
  GPUComputePassDescriptor,
  GPUFragmentState,
  GPULoadOp,
  GPUProgrammableStage,
  GPUSamplerDescriptor,
  GPUShaderModuleDescriptor,
  GPUStoreOp,
  GPUVertexState,
  GPUBindGroupLayoutDescriptor,
  RHIComputePassEncoder,
  RHIComputePipelineDescriptor,
  RHIDevice,
  RHIRenderPassEncoder,
  RHIRenderPipelineDescriptor
} from '../../rhi/contracts';
import type { TextureGraphRange } from '../ranges';
import type {
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from '../prepared-resources';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  TextureHandle,
  TextureRange,
  TextureUsage
} from './render-graph-types';

export interface DeclaredRasterColorAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly clearValue?: GPUColor;
}

export interface DeclaredRasterDepthStencilAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly depthLoadOp?: GPULoadOp;
  readonly depthStoreOp?: GPUStoreOp;
  readonly depthClearValue?: number;
  readonly stencilLoadOp?: GPULoadOp;
  readonly stencilStoreOp?: GPUStoreOp;
  readonly stencilClearValue?: number;
}

export interface DeclaredRasterPass {
  readonly label?: string;
  readonly colorAttachments: readonly DeclaredRasterColorAttachment[];
  readonly depthStencilAttachment?: DeclaredRasterDepthStencilAttachment;
}

export interface RestrictedBindGroupEntry {
  readonly binding: number;
  readonly resource: RestrictedTextureView | RestrictedBufferSlice | RestrictedSampler;
}

export interface RestrictedBindGroupDescriptor {
  readonly label?: string;
  readonly layout: RestrictedBindGroupLayout;
  readonly entries: readonly RestrictedBindGroupEntry[];
}

/** Opaque pass-local capability; its raw descriptor and physical resources stay internal. */
export interface RestrictedBindGroup {
  readonly kind: 'restricted-bind-group';
}

export interface RestrictedSampler {
  readonly kind: 'restricted-sampler';
}

export interface RestrictedShaderModule {
  readonly kind: 'restricted-shader-module';
}

export interface RestrictedBindGroupLayout {
  readonly kind: 'restricted-bind-group-layout';
}

export interface RestrictedPipelineLayout {
  readonly kind: 'restricted-pipeline-layout';
}

export interface RestrictedRenderPipeline {
  readonly kind: 'restricted-render-pipeline';
}

export interface RestrictedComputePipeline {
  readonly kind: 'restricted-compute-pipeline';
}

/** Pass-local capabilities for one externally prepared indexed draw. */
export interface RestrictedPreparedDrawResources {
  readonly pipeline: RestrictedRenderPipeline;
  readonly bindGroups: readonly RestrictedBindGroup[];
  readonly dynamicOffsets: readonly number[];
  readonly vertexBuffers: readonly RestrictedBufferSlice[];
  readonly indexBuffer: RestrictedBufferSlice;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly firstIndex: number;
  readonly indexCount: number;
}

export interface RestrictedPipelineLayoutDescriptor {
  readonly label?: string;
  readonly bindGroupLayouts: readonly RestrictedBindGroupLayout[];
}

export type RestrictedVertexState = Omit<GPUVertexState, 'module'> & {
  readonly module: RestrictedShaderModule;
};

export type RestrictedFragmentState = Omit<GPUFragmentState, 'module'> & {
  readonly module: RestrictedShaderModule;
};

export type RestrictedProgrammableStage = Omit<GPUProgrammableStage, 'module'> & {
  readonly module: RestrictedShaderModule;
};

export type RestrictedRenderPipelineDescriptor = Omit<
  RHIRenderPipelineDescriptor,
  'layout' | 'vertex' | 'fragment'
> & {
  readonly layout?: RestrictedPipelineLayout;
  readonly vertex?: RestrictedVertexState;
  readonly fragment?: RestrictedFragmentState;
};

export type RestrictedComputePipelineDescriptor = Omit<
  RHIComputePipelineDescriptor,
  'layout' | 'compute'
> & {
  readonly layout?: RestrictedPipelineLayout;
  readonly compute?: RestrictedProgrammableStage;
};

export type RestrictedRenderPassEncoder = Omit<
  RHIRenderPassEncoder,
  'setBindGroup' | 'setPipeline' | 'setVertexBuffer' | 'setIndexBuffer' | 'drawIndirect'
> & {
  setBindGroup(index: number, bindGroup: RestrictedBindGroup, offsets?: readonly number[]): void;
  setPipeline(pipeline: RestrictedRenderPipeline): void;
  setVertexBuffer(
    slot: number,
    buffer: RestrictedBufferSlice,
    offset?: number,
    size?: number
  ): void;
  setIndexBuffer(
    buffer: RestrictedBufferSlice,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number
  ): void;
  drawIndirect(buffer: RestrictedBufferSlice, offset: number): void;
};

export type RestrictedComputePassEncoder = Omit<
  RHIComputePassEncoder,
  'setBindGroup' | 'setPipeline' | 'dispatchWorkgroupsIndirect'
> & {
  setBindGroup(index: number, bindGroup: RestrictedBindGroup, offsets?: readonly number[]): void;
  setPipeline(pipeline: RestrictedComputePipeline): void;
  dispatchWorkgroupsIndirect(buffer: RestrictedBufferSlice, offset: number): void;
};

/** Portable creation only: no queue, allocation, encoder, native extension, or destroy. */
export interface RestrictedPortableDevice {
  readonly capabilities: RHIDevice['capabilities'];
  readonly generation: RHIDevice['generation'];
  readonly state: RHIDevice['state'];
  readonly lost: RHIDevice['lost'];
  createSampler(descriptor?: GPUSamplerDescriptor): RestrictedSampler;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): RestrictedShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): RestrictedBindGroupLayout;
  createPipelineLayout(descriptor: RestrictedPipelineLayoutDescriptor): RestrictedPipelineLayout;
  createBindGroup(descriptor: RestrictedBindGroupDescriptor): RestrictedBindGroup;
  createRenderPipeline(descriptor: RestrictedRenderPipelineDescriptor): RestrictedRenderPipeline;
  createComputePipeline(
    descriptor?: RestrictedComputePipelineDescriptor
  ): RestrictedComputePipeline;
}

/** The only GPU capability visible to a user render-pass callback. */
export interface RestrictedPassContext {
  readonly device: RestrictedPortableDevice;
  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView;
  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice;
  renderPipeline(token: PreparedRenderPipelineToken): RestrictedRenderPipeline;
  computePipeline(token: PreparedComputePipelineToken): RestrictedComputePipeline;
  drawResources(token: PreparedDrawResourcesToken): RestrictedPreparedDrawResources;
  beginRaster(descriptor: DeclaredRasterPass): RestrictedRenderPassEncoder;
  beginCompute(descriptor?: GPUComputePassDescriptor): RestrictedComputePassEncoder;
  copyBufferToBuffer(
    source: RestrictedBufferSlice,
    destination: RestrictedBufferSlice,
    size?: number
  ): void;
}

/** Opaque usable view capability; only its owning context can lower it. */
export interface RestrictedTextureView {
  readonly kind: 'restricted-texture-view';
  readonly range: TextureGraphRange;
}

/** Opaque usable slice capability; copy and binding lower exactly this interval. */
export interface RestrictedBufferSlice {
  readonly kind: 'restricted-buffer-slice';
  readonly offset: number;
  readonly size: number;
}

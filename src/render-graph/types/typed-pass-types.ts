import type { GPUColor, GPUIndexFormat } from '../../rhi/contracts';
import type {
  PreparedBindGroupLayoutToken,
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from '../builder/prepared-resources';
import type { SurfaceFrameToken } from '../builder/pass-builder';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferUsage,
  BufferWriteUsage,
  ExternalResourceState,
  GraphHandle,
  GraphResourceCreateOptions,
  PassToken,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureUsage,
  TextureWriteUsage
} from './render-graph-types';
import type {
  RestrictedBindGroup,
  RestrictedBufferSlice,
  RestrictedComputePipeline,
  RestrictedPreparedDrawResources,
  RestrictedBindGroupLayout,
  RestrictedPortableDevice,
  RestrictedRenderPipeline,
  RestrictedTextureView
} from './restricted-context-types';

export type PassKind = 'raster' | 'compute' | 'copy';

export interface ColorAttachmentOptions {
  readonly range?: TextureRange;
  readonly load: 'load' | 'clear';
  readonly clearValue?: readonly [number, number, number, number] | GPUColor;
  readonly store: 'auto' | 'store' | 'discard';
}

export interface DepthStencilAttachmentOptions {
  readonly range?: TextureRange;
  readonly depthLoad?: 'load' | 'clear';
  readonly depthClearValue?: number;
  readonly depthStore?: 'auto' | 'store' | 'discard';
  readonly depthAccess?: 'read' | 'write';
  readonly stencilLoad?: 'load' | 'clear';
  readonly stencilClearValue?: number;
  readonly stencilStore?: 'auto' | 'store' | 'discard';
  readonly stencilAccess?: 'read' | 'write';
}

export interface DeclaredColorAttachment {
  readonly slot: number;
  readonly input: TextureHandle;
  readonly output: TextureHandle;
  readonly options: ColorAttachmentOptions;
}

export interface DeclaredDepthStencilAttachment {
  readonly input: TextureHandle;
  readonly output?: TextureHandle | undefined;
  readonly options: DepthStencilAttachmentOptions;
}

export interface DeclaredResolveAttachment {
  readonly slot: number;
  readonly source: TextureHandle;
  readonly destination: TextureHandle;
  readonly output: TextureHandle;
  readonly sourceRange: TextureRange;
  readonly destinationRange: TextureRange;
}

export interface RasterCommands {
  setPipeline(pipeline: RestrictedRenderPipeline): void;
  setBindGroup(
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void;
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
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth?: number,
    maxDepth?: number
  ): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  setBlendConstant?(color: GPUColor): void;
  setStencilReference?(reference: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void;
  drawIndirect?(indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void;
}

export interface ComputeCommands {
  setPipeline(pipeline: RestrictedComputePipeline): void;
  setBindGroup(
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void;
  dispatchWorkgroups(
    workgroupCountX: number,
    workgroupCountY?: number,
    workgroupCountZ?: number
  ): void;
  dispatchWorkgroupsIndirect?(indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void;
}

export interface CopyCommands {
  copyBufferToBuffer(
    source: RestrictedBufferSlice,
    destination: RestrictedBufferSlice,
    size?: number
  ): void;
}

export interface DeclaredResourceResolver {
  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView;
  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice;
  renderPipeline(token: PreparedRenderPipelineToken): RestrictedRenderPipeline;
  computePipeline(token: PreparedComputePipelineToken): RestrictedComputePipeline;
  bindGroupLayout(token: PreparedBindGroupLayoutToken): RestrictedBindGroupLayout;
  drawResources(token: PreparedDrawResourcesToken): RestrictedPreparedDrawResources;
}

export interface RasterPassContext extends DeclaredResourceResolver {
  readonly raster: RasterCommands;
  readonly device: RestrictedPortableDevice;
}

export interface ComputePassContext extends DeclaredResourceResolver {
  readonly compute: ComputeCommands;
  readonly device: RestrictedPortableDevice;
}

export interface CopyPassContext extends DeclaredResourceResolver {
  readonly copy: CopyCommands;
  readonly device: RestrictedPortableDevice;
}

export type ComputeTextureWriteUsage = 'storage-write';
export type ComputeBufferWriteUsage = 'storage-write';
export type CopyTextureWriteUsage = 'copy-dst';
export type CopyBufferWriteUsage = 'copy-dst';

export interface GraphResourceBuilder {
  createTexture(descriptor: TextureDescriptor, options?: GraphResourceCreateOptions): TextureHandle;
  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle;
  readTexture(handle: TextureHandle, usage: TextureReadUsage, range?: TextureRange): TextureHandle;
  readBuffer(handle: BufferHandle, usage: BufferReadUsage, range?: BufferRange): BufferHandle;
  sideEffect(label: string): void;
  after(pass: PassToken): void;
  exportResource(handle: GraphHandle, finalState: ExternalResourceState): void;
  present(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void;
}

export interface RasterPassBuilder extends GraphResourceBuilder {
  colorAttachment(
    slot: number,
    input: TextureHandle,
    options: ColorAttachmentOptions
  ): TextureHandle;
  depthStencilAttachment(
    input: TextureHandle,
    options: DepthStencilAttachmentOptions
  ): TextureHandle;
  resolveAttachment?(
    slot: number,
    source: TextureHandle,
    destination: TextureHandle
  ): TextureHandle;
  useRenderPipeline(token: PreparedRenderPipelineToken): void;
  useDrawResources(token: PreparedDrawResourcesToken): void;
}

export interface ComputePassBuilder extends GraphResourceBuilder {
  writeTexture(
    handle: TextureHandle,
    usage: ComputeTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle;
  writeBuffer(
    handle: BufferHandle,
    usage: ComputeBufferWriteUsage,
    range?: BufferRange
  ): BufferHandle;
  useComputePipeline(token: PreparedComputePipelineToken): void;
}

export interface CopyPassBuilder extends GraphResourceBuilder {
  writeTexture(
    handle: TextureHandle,
    usage: CopyTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle;
  writeBuffer(handle: BufferHandle, usage: CopyBufferWriteUsage, range?: BufferRange): BufferHandle;
}

export interface RasterPassDescriptor<TResources> {
  readonly id: string;
  setup(builder: RasterPassBuilder): TResources;
  run(context: RasterPassContext, resources: TResources): void;
}

export interface ComputePassDescriptor<TResources> {
  readonly id: string;
  setup(builder: ComputePassBuilder): TResources;
  run(context: ComputePassContext, resources: TResources): void;
}

export interface CopyPassDescriptor<TResources> {
  readonly id: string;
  setup(builder: CopyPassBuilder): TResources;
  run(context: CopyPassContext, resources: TResources): void;
}

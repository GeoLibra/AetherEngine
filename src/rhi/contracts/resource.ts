import type {
  GPUBindGroupLayoutEntry,
  GPUBufferUsageFlags,
  GPUIndexFormat,
  GPUMapModeFlags,
  GPUOrigin3D,
  GPUPrimitiveTopology,
  GPUTextureAspect,
  GPUTextureFormat,
  GPUTextureUsageFlags
} from './webgpu';
import type { RHIResourceState } from './lifecycle';
import type {
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor,
  RHITextureViewDescriptor
} from './descriptor';

export type RHIResourceKind =
  | 'buffer'
  | 'texture'
  | 'texture-view'
  | 'sampler'
  | 'shader-module'
  | 'bind-group-layout'
  | 'pipeline-layout'
  | 'bind-group'
  | 'render-target'
  | 'render-pipeline'
  | 'compute-pipeline'
  | 'command-buffer';

export interface RHIResource {
  readonly id: number;
  readonly kind: RHIResourceKind;
  readonly label: string | undefined;
  readonly generation: number;
  readonly state: RHIResourceState;
  dispose(): void;
}

export interface RHIBuffer extends RHIResource {
  readonly kind: 'buffer';
  readonly descriptor: Readonly<RHIBufferDescriptor>;
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
  mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}

export interface RHITexture extends RHIResource {
  readonly kind: 'texture';
  readonly descriptor: Readonly<RHITextureDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
  createView(descriptor?: RHITextureViewDescriptor): RHITextureView;
}

export interface RHITextureView extends RHIResource {
  readonly kind: 'texture-view';
  readonly texture: RHITexture;
  readonly descriptor: Readonly<RHITextureViewDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
}

export interface RHISampler extends RHIResource {
  readonly kind: 'sampler';
  readonly descriptor: Readonly<RHISamplerDescriptor>;
}

export interface RHIShaderModule extends RHIResource {
  readonly kind: 'shader-module';
  readonly descriptor: Readonly<RHIShaderModuleDescriptor>;
}

export interface RHIBindGroupLayout extends RHIResource {
  readonly kind: 'bind-group-layout';
  readonly descriptor: Readonly<RHIBindGroupLayoutDescriptor>;
  readonly dynamicBindingCount: number;
  getEntry(binding: number): GPUBindGroupLayoutEntry | undefined;
}

export interface RHIPipelineLayout extends RHIResource {
  readonly kind: 'pipeline-layout';
  readonly descriptor: Readonly<GPUPipelineLayoutDescriptor>;
  readonly bindGroupLayouts: readonly RHIBindGroupLayout[];
}

export interface RHIBindGroup extends RHIResource {
  readonly kind: 'bind-group';
  readonly descriptor: Readonly<GPUBindGroupDescriptor>;
  readonly layout: RHIBindGroupLayout;
  readonly dynamicBindingCount: number;
}

export interface RHIRenderPipeline extends RHIResource {
  readonly kind: 'render-pipeline';
  readonly descriptor: Readonly<RHIRenderPipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;
  readonly topology: GPUPrimitiveTopology | undefined;
}

export interface RHIComputePipeline extends RHIResource {
  readonly kind: 'compute-pipeline';
  readonly descriptor: Readonly<RHIComputePipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;
}

export type GPUVertexFormat = string;
export type GPUVertexStepMode = 'vertex' | 'instance';
export type GPUFrontFace = 'ccw' | 'cw';
export type GPUCullMode = 'none' | 'front' | 'back';
export type GPUIndexFormatWithUndefined = GPUIndexFormat | undefined;
export type GPUCompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';
export type GPUBlendFactor = string;
export type GPUBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
export type GPUColorWriteFlags = number;

export interface GPUProgrammableStage {
  module: RHIShaderModule;
  entryPoint?: string;
  constants?: Readonly<Record<string, number>>;
}

export interface GPUVertexAttribute {
  format: GPUVertexFormat;
  offset: number;
  shaderLocation: number;
}

export interface GPUVertexBufferLayout {
  arrayStride: number;
  stepMode?: GPUVertexStepMode;
  attributes: readonly GPUVertexAttribute[];
}

export interface GPUVertexState extends GPUProgrammableStage {
  buffers?: readonly (GPUVertexBufferLayout | null)[];
}

export interface GPUBlendComponent {
  operation?: GPUBlendOperation;
  srcFactor: GPUBlendFactor;
  dstFactor: GPUBlendFactor;
}

export interface GPUBlendState {
  color: GPUBlendComponent;
  alpha: GPUBlendComponent;
}

export interface GPUColorTargetState {
  format: GPUTextureFormat;
  blend?: GPUBlendState;
  writeMask?: GPUColorWriteFlags;
}

export interface GPUFragmentState extends GPUProgrammableStage {
  targets: readonly (GPUColorTargetState | null)[];
}

export interface GPUPrimitiveState {
  topology?: GPUPrimitiveTopology;
  stripIndexFormat?: GPUIndexFormatWithUndefined;
  frontFace?: GPUFrontFace;
  cullMode?: GPUCullMode;
  unclippedDepth?: boolean;
}

export interface GPUDepthStencilState {
  format: GPUTextureFormat;
  depthWriteEnabled?: boolean;
  depthCompare?: GPUCompareFunction;
}

export interface GPUMultisampleState {
  count?: number;
  mask?: number;
  alphaToCoverageEnabled?: boolean;
}

export interface GPUBufferBinding {
  buffer: RHIBuffer;
  offset?: number;
  size?: number;
}

export type GPUBindingResource = RHISampler | RHITextureView | GPUBufferBinding;

export interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBindingResource;
}

export interface GPUBindGroupDescriptor {
  label?: string;
  layout: RHIBindGroupLayout;
  entries: readonly GPUBindGroupEntry[];
}

export interface GPUPipelineLayoutDescriptor {
  label?: string;
  bindGroupLayouts: readonly RHIBindGroupLayout[];
}

export interface GPUImageCopyTexture {
  texture: RHITexture;
  mipLevel?: number;
  origin?: GPUOrigin3D;
  aspect?: GPUTextureAspect;
}

export interface GPUImageCopyBuffer {
  buffer: RHIBuffer;
  offset?: number;
  bytesPerRow?: number;
  rowsPerImage?: number;
}

export interface RHIRenderPipelineDescriptor {
  label?: string;
  layout?: RHIPipelineLayout;
  vertex?: GPUVertexState;
  primitive?: GPUPrimitiveState;
  depthStencil?: GPUDepthStencilState;
  multisample?: GPUMultisampleState;
  fragment?: GPUFragmentState;
}

export interface RHIComputePipelineDescriptor {
  label?: string;
  layout?: RHIPipelineLayout;
  compute?: GPUProgrammableStage;
}

import type {
  GPUBindGroupLayoutDescriptor,
  GPUBindGroupLayoutEntry,
  GPUBufferDescriptor,
  GPUBufferUsageFlags,
  GPUMapModeFlags,
  GPUOrigin3D,
  GPUPrimitiveTopology,
  GPUSamplerDescriptor,
  GPUShaderModuleDescriptor,
  GPUTextureAspect,
  GPUTextureDescriptor,
  GPUTextureFormat,
  GPUTextureUsageFlags,
  GPUTextureViewDescriptor
} from './webgpu-types';

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
  readonly released: boolean;
}

export interface RHIBuffer extends RHIResource {
  readonly kind: 'buffer';
  readonly descriptor: Readonly<GPUBufferDescriptor>;
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
  mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}

export interface RHITexture extends RHIResource {
  readonly kind: 'texture';
  readonly descriptor: Readonly<GPUTextureDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
  createView(descriptor?: GPUTextureViewDescriptor): RHITextureView;
}

export interface RHITextureView extends RHIResource {
  readonly kind: 'texture-view';
  readonly texture: RHITexture;
  readonly descriptor: Readonly<GPUTextureViewDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
}

export interface RHISampler extends RHIResource {
  readonly kind: 'sampler';
  readonly descriptor: Readonly<GPUSamplerDescriptor>;
}

export interface RHIShaderModule extends RHIResource {
  readonly kind: 'shader-module';
  readonly descriptor: Readonly<GPUShaderModuleDescriptor>;
}

export interface RHIBindGroupLayout extends RHIResource {
  readonly kind: 'bind-group-layout';
  readonly descriptor: Readonly<GPUBindGroupLayoutDescriptor>;
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

export interface RHIRenderPipelineDescriptor {
  label?: string;
  layout?: RHIPipelineLayout;
  primitive?: {
    topology?: GPUPrimitiveTopology;
  };
}

export interface RHIComputePipelineDescriptor {
  label?: string;
  layout?: RHIPipelineLayout;
}

export type GPUBufferUsageFlags = number;
export type GPUTextureUsageFlags = number;
export type GPUMapModeFlags = number;
export type GPUSize64 = number;
export type GPUIntegerCoordinate = number;
export type GPUIndex32 = number;
export type GPULoadOp = 'load' | 'clear';
export type GPUStoreOp = 'store' | 'discard';
export type GPUTextureFormat = string;
export type GPUTextureAspect = 'all' | 'stencil-only' | 'depth-only';
export type GPUIndexFormat = 'uint16' | 'uint32';
export type GPUPrimitiveTopology =
  | 'point-list'
  | 'line-list'
  | 'line-strip'
  | 'triangle-list'
  | 'triangle-strip';
export type GPUColor = readonly [number, number, number, number] | { r: number; g: number; b: number; a: number };
export type GPUExtent3D =
  | number
  | readonly [GPUIntegerCoordinate, GPUIntegerCoordinate?, GPUIntegerCoordinate?]
  | {
      width: GPUIntegerCoordinate;
      height?: GPUIntegerCoordinate;
      depthOrArrayLayers?: GPUIntegerCoordinate;
    };
export type GPUOrigin3D =
  | readonly [GPUIntegerCoordinate, GPUIntegerCoordinate?, GPUIntegerCoordinate?]
  | {
      x?: GPUIntegerCoordinate;
      y?: GPUIntegerCoordinate;
      z?: GPUIntegerCoordinate;
    };
export type RHIUploadData = ArrayBuffer | ArrayBufferView;

export interface BufferWriteRange {
  offset: number;
  data: RHIUploadData;
}

export interface GPUBufferDescriptor {
  label?: string;
  size: GPUSize64;
  usage: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
}

export interface GPUTextureDescriptor {
  label?: string;
  size: GPUExtent3D;
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
  dimension?: '1d' | '2d' | '3d';
  mipLevelCount?: number;
  sampleCount?: number;
}

export interface GPUTextureViewDescriptor {
  label?: string;
  format?: GPUTextureFormat;
  dimension?: '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
  baseMipLevel?: number;
  mipLevelCount?: number;
  baseArrayLayer?: number;
  arrayLayerCount?: number;
}

export interface GPUSamplerDescriptor {
  label?: string;
  addressModeU?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  addressModeV?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  addressModeW?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  magFilter?: 'nearest' | 'linear';
  minFilter?: 'nearest' | 'linear';
  mipmapFilter?: 'nearest' | 'linear';
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
  maxAnisotropy?: number;
}

export type GPUShaderStageFlags = number;

export interface GPUShaderModuleDescriptor {
  label?: string;
  code: string;
}

export type GPUBufferBindingType = 'uniform' | 'storage' | 'read-only-storage';
export type GPUSamplerBindingType = 'filtering' | 'non-filtering' | 'comparison';
export type GPUTextureSampleType = 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';
export type GPUStorageTextureAccess = 'write-only' | 'read-only' | 'read-write';

export interface GPUBufferBindingLayout {
  type?: GPUBufferBindingType;
  hasDynamicOffset?: boolean;
  minBindingSize?: number;
}

export interface GPUSamplerBindingLayout {
  type?: GPUSamplerBindingType;
}

export interface GPUTextureBindingLayout {
  sampleType?: GPUTextureSampleType;
  viewDimension?: GPUTextureViewDescriptor['dimension'];
  multisampled?: boolean;
}

export interface GPUStorageTextureBindingLayout {
  access: GPUStorageTextureAccess;
  format: GPUTextureFormat;
  viewDimension?: GPUTextureViewDescriptor['dimension'];
}

export interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: GPUShaderStageFlags;
  buffer?: GPUBufferBindingLayout;
  sampler?: GPUSamplerBindingLayout;
  texture?: GPUTextureBindingLayout;
  storageTexture?: GPUStorageTextureBindingLayout;
}

export interface GPUBindGroupLayoutDescriptor {
  label?: string;
  entries: readonly GPUBindGroupLayoutEntry[];
}

export interface GPUCommandEncoderDescriptor {
  label?: string;
}

export interface GPUCommandBufferDescriptor {
  label?: string;
}

export interface GPUComputePassDescriptor {
  label?: string;
}

export interface GPUImageDataLayout {
  offset?: number;
  bytesPerRow?: number;
  rowsPerImage?: number;
}

export interface GPUSupportedLimits {
  readonly [name: string]: number | undefined;
}

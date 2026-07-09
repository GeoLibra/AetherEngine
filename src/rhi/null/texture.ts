import { assertResourceLive, assertResourceOwnedBy, NullResourceBase, toResourceRef } from '../resource';
import type {
  GPUExtent3D,
  GPUImageCopyTexture,
  GPUImageDataLayout,
  GPUSamplerDescriptor,
  GPUTextureDescriptor,
  GPUTextureFormat,
  GPUTextureUsageFlags,
  GPUTextureViewDescriptor,
  RHINormalizedExtent3D,
  RHINormalizedImageCopyTexture,
  RHINormalizedOrigin3D,
  RHISampler,
  RHITexture,
  RHITextureView
} from '../types';

export class NullTexture extends NullResourceBase implements RHITexture {
  readonly kind = 'texture';
  readonly descriptor: Readonly<GPUTextureDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;

  constructor(
    id: number,
    owner: symbol,
    descriptor: GPUTextureDescriptor,
    private readonly allocateViewId: () => number
  ) {
    super(id, owner, descriptor.label);
    const size = normalizeTextureSize(descriptor.size);
    this.descriptor = { ...descriptor, size: { ...size } };
    this.width = size.width;
    this.height = size.height;
    this.depthOrArrayLayers = size.depthOrArrayLayers;
    this.format = descriptor.format;
    this.usage = descriptor.usage;
  }

  createView(descriptor: GPUTextureViewDescriptor = {}): RHITextureView {
    if (this.released) {
      throw new Error(`Texture "${this.label ?? this.id}" has been released.`);
    }
    return new NullTextureView(this.allocateViewId(), this.owner, this, descriptor);
  }
}

export class NullTextureView extends NullResourceBase implements RHITextureView {
  readonly kind = 'texture-view';
  readonly descriptor: Readonly<GPUTextureViewDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;

  constructor(id: number, owner: symbol, readonly texture: RHITexture, descriptor: GPUTextureViewDescriptor) {
    super(id, owner, descriptor.label ?? texture.label);
    this.descriptor = { ...descriptor };
    this.width = texture.width;
    this.height = texture.height;
    this.depthOrArrayLayers = descriptor.arrayLayerCount ?? texture.depthOrArrayLayers;
    this.format = descriptor.format ?? texture.format;
  }

  override get released(): boolean {
    return this.isReleased || this.texture.released;
  }
}

export class NullSampler extends NullResourceBase implements RHISampler {
  readonly kind = 'sampler';
  readonly descriptor: Readonly<GPUSamplerDescriptor>;

  constructor(id: number, owner: symbol, descriptor: GPUSamplerDescriptor) {
    super(id, owner, descriptor.label);
    this.descriptor = { ...descriptor };
  }
}

export function normalizeTextureSize(size: GPUExtent3D): RHINormalizedExtent3D {
  if (typeof size === 'number') {
    return { width: size, height: 1, depthOrArrayLayers: 1 };
  }
  if (Array.isArray(size)) {
    return {
      width: size[0] ?? 1,
      height: size[1] ?? 1,
      depthOrArrayLayers: size[2] ?? 1
    };
  }
  if (!('width' in size)) {
    throw new Error('Texture size object must include width.');
  }
  return {
    width: size.width,
    height: size.height ?? 1,
    depthOrArrayLayers: size.depthOrArrayLayers ?? 1
  };
}

export function validateImageDataLayout(dataLayout: GPUImageDataLayout): void {
  validateOptionalNonNegativeInteger(dataLayout.offset, 'Texture data layout offset');
  validateOptionalNonNegativeInteger(dataLayout.bytesPerRow, 'Texture data layout bytesPerRow');
  validateOptionalNonNegativeInteger(dataLayout.rowsPerImage, 'Texture data layout rowsPerImage');
}

export function normalizeAndValidateExtent(size: GPUExtent3D): RHINormalizedExtent3D {
  const normalized = normalizeTextureSize(size);
  if (
    !Number.isInteger(normalized.width) ||
    !Number.isInteger(normalized.height) ||
    !Number.isInteger(normalized.depthOrArrayLayers) ||
    normalized.width < 0 ||
    normalized.height < 0 ||
    normalized.depthOrArrayLayers < 0
  ) {
    throw new Error('Texture copy size must contain non-negative integer dimensions.');
  }
  return normalized;
}

export function validateTextureCopyView(
  view: GPUImageCopyTexture,
  owner: symbol,
  copySize: RHINormalizedExtent3D
): RHINormalizedImageCopyTexture {
  assertResourceOwnedBy(view.texture, owner);
  assertResourceLive(view.texture);

  const mipLevel = view.mipLevel ?? 0;
  if (!Number.isInteger(mipLevel) || mipLevel < 0) {
    throw new Error(`Texture mipLevel ${mipLevel} must be a non-negative integer.`);
  }
  const mipLevelCount = view.texture.descriptor.mipLevelCount ?? 1;
  if (mipLevel >= mipLevelCount) {
    throw new Error(
      `Texture mipLevel ${mipLevel} is outside texture "${view.texture.label ?? view.texture.id}" mipLevelCount ${mipLevelCount}.`
    );
  }

  const origin = normalizeAndValidateOrigin(view.origin);
  const aspect = view.aspect ?? 'all';
  if (aspect !== 'all' && aspect !== 'stencil-only' && aspect !== 'depth-only') {
    throw new Error(`Texture aspect "${aspect}" is not supported.`);
  }

  const mipSize = getTextureMipSize(view.texture, mipLevel);
  if (
    origin.x + copySize.width > mipSize.width ||
    origin.y + copySize.height > mipSize.height ||
    origin.z + copySize.depthOrArrayLayers > mipSize.depthOrArrayLayers
  ) {
    throw new Error(
      `Texture copy range exceeds texture "${view.texture.label ?? view.texture.id}" mip level ${mipLevel} bounds ${mipSize.width}x${mipSize.height}x${mipSize.depthOrArrayLayers}.`
    );
  }

  return {
    texture: toResourceRef(view.texture),
    mipLevel,
    origin,
    aspect
  };
}

function validateOptionalNonNegativeInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${label} ${value} must be a non-negative integer.`);
  }
}

function normalizeAndValidateOrigin(origin: GPUImageCopyTexture['origin']): RHINormalizedOrigin3D {
  const normalized = normalizeOrigin(origin);
  if (
    !Number.isInteger(normalized.x) ||
    !Number.isInteger(normalized.y) ||
    !Number.isInteger(normalized.z) ||
    normalized.x < 0 ||
    normalized.y < 0 ||
    normalized.z < 0
  ) {
    throw new Error('Texture copy origin must contain non-negative integer coordinates.');
  }
  return normalized;
}

function normalizeOrigin(origin: GPUImageCopyTexture['origin']): RHINormalizedOrigin3D {
  if (origin === undefined) {
    return { x: 0, y: 0, z: 0 };
  }
  if (Array.isArray(origin)) {
    const coordinates = origin as readonly number[];
    return {
      x: coordinates[0] ?? 0,
      y: coordinates[1] ?? 0,
      z: coordinates[2] ?? 0
    };
  }
  const objectOrigin = origin as { x?: number; y?: number; z?: number };
  return {
    x: objectOrigin.x ?? 0,
    y: objectOrigin.y ?? 0,
    z: objectOrigin.z ?? 0
  };
}

function getTextureMipSize(texture: RHITexture, mipLevel: number): RHINormalizedExtent3D {
  const scale = 2 ** mipLevel;
  const scaleDepth = texture.descriptor.dimension === '3d';
  return {
    width: Math.max(1, Math.floor(texture.width / scale)),
    height: Math.max(1, Math.floor(texture.height / scale)),
    depthOrArrayLayers: scaleDepth
      ? Math.max(1, Math.floor(texture.depthOrArrayLayers / scale))
      : texture.depthOrArrayLayers
  };
}

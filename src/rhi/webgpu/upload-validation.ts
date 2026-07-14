import type { GPUImageCopyTexture, RHITexture } from '../resource-types';
import type { GPUExtent3D, GPUImageDataLayout, RHIUploadData } from '../webgpu-types';
import { normalizeExtent } from './resource';

export function copyUploadBytes(data: RHIUploadData): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return new Uint8Array(data.slice(0));
}

export function validateUploadBufferRange(offset: number, size: number, bufferSize: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > bufferSize) {
    throw new Error(`Buffer range ${offset}..${offset + size} is outside buffer size ${bufferSize}.`);
  }
}

export function validateUploadDataLayout(layout: GPUImageDataLayout): void {
  validateOptionalInteger(layout.offset, 'Texture data layout offset');
  validateOptionalInteger(layout.bytesPerRow, 'Texture data layout bytesPerRow');
  validateOptionalInteger(layout.rowsPerImage, 'Texture data layout rowsPerImage');
}

export function normalizeUploadExtent(size: GPUExtent3D) {
  const extent = normalizeExtent(size);
  if (
    !Number.isInteger(extent.width) || !Number.isInteger(extent.height) ||
    !Number.isInteger(extent.depthOrArrayLayers) || extent.width < 0 ||
    extent.height < 0 || extent.depthOrArrayLayers < 0
  ) throw new Error('Texture copy size must contain non-negative integer dimensions.');
  return extent;
}

export function lowerAndValidateTextureDestination(
  destination: GPUImageCopyTexture,
  texture: RHITexture,
  nativeTexture: unknown,
  copySize: Readonly<{ width: number; height: number; depthOrArrayLayers: number }>
): Readonly<Record<string, unknown>> {
  const mipLevel = destination.mipLevel ?? 0;
  const mipCount = texture.descriptor.mipLevelCount ?? 1;
  if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= mipCount) {
    throw new Error(`Texture mipLevel ${mipLevel} is outside texture "${texture.label ?? texture.id}" mipLevelCount ${mipCount}.`);
  }
  const origin = normalizeOrigin(destination.origin);
  const scale = 2 ** mipLevel;
  const depth = texture.descriptor.dimension === '3d'
    ? Math.max(1, Math.floor(texture.depthOrArrayLayers / scale))
    : texture.depthOrArrayLayers;
  const bounds = {
    width: Math.max(1, Math.floor(texture.width / scale)),
    height: Math.max(1, Math.floor(texture.height / scale)),
    depthOrArrayLayers: depth
  };
  if (
    origin.x + copySize.width > bounds.width || origin.y + copySize.height > bounds.height ||
    origin.z + copySize.depthOrArrayLayers > bounds.depthOrArrayLayers
  ) {
    throw new Error(
      `Texture copy range exceeds texture "${texture.label ?? texture.id}" mip level ${mipLevel} bounds ` +
      `${bounds.width}x${bounds.height}x${bounds.depthOrArrayLayers}.`
    );
  }
  return Object.freeze({
    texture: nativeTexture,
    mipLevel,
    origin: Object.freeze(origin),
    aspect: destination.aspect ?? 'all'
  });
}

function normalizeOrigin(origin: GPUImageCopyTexture['origin']) {
  const tuple = Array.isArray(origin) ? origin as readonly number[] : undefined;
  const object = tuple === undefined
    ? origin as { x?: number; y?: number; z?: number } | undefined
    : undefined;
  const value = tuple === undefined
    ? { x: object?.x ?? 0, y: object?.y ?? 0, z: object?.z ?? 0 }
    : { x: tuple[0] ?? 0, y: tuple[1] ?? 0, z: tuple[2] ?? 0 };
  if (
    !Number.isInteger(value.x) || !Number.isInteger(value.y) || !Number.isInteger(value.z) ||
    value.x < 0 || value.y < 0 || value.z < 0
  ) throw new Error('Texture copy origin must contain non-negative integer coordinates.');
  return value;
}

function validateOptionalInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${label} ${value} must be a non-negative integer.`);
  }
}

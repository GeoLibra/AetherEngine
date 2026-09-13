import type { TextureDescriptor, TextureRange } from '../types';
import type { TextureGraphRange } from './types';

export function fullTextureRange(descriptor: TextureDescriptor): TextureGraphRange {
  return normalizeTextureRange(descriptor);
}

export function normalizeTextureRange(
  descriptor: TextureDescriptor,
  range?: TextureRange
): TextureGraphRange {
  assertTextureDescriptor(descriptor);
  const normalized = range ?? {
    baseMipLevel: 0,
    mipLevelCount: descriptor.mipLevelCount,
    baseArrayLayer: 0,
    arrayLayerCount: descriptor.depthOrArrayLayers,
    aspect: 'all' as const
  };
  assertTextureRange(normalized, descriptor);

  return Object.freeze({
    kind: 'texture' as const,
    baseMipLevel: normalized.baseMipLevel,
    mipLevelCount: normalized.mipLevelCount,
    baseArrayLayer: normalized.baseArrayLayer,
    arrayLayerCount: normalized.arrayLayerCount,
    aspect: normalized.aspect,
    mipLevelEnd: normalized.baseMipLevel + normalized.mipLevelCount,
    arrayLayerEnd: normalized.baseArrayLayer + normalized.arrayLayerCount
  });
}

export function textureGraphRange(
  baseMipLevel: number,
  mipLevelEnd: number,
  baseArrayLayer: number,
  arrayLayerEnd: number,
  aspect: TextureGraphRange['aspect']
): TextureGraphRange {
  return Object.freeze({
    kind: 'texture',
    baseMipLevel,
    mipLevelCount: mipLevelEnd - baseMipLevel,
    baseArrayLayer,
    arrayLayerCount: arrayLayerEnd - baseArrayLayer,
    aspect,
    mipLevelEnd,
    arrayLayerEnd
  });
}

function assertTextureDescriptor(descriptor: TextureDescriptor): void {
  assertPositiveInteger(descriptor.width, 'Texture descriptor width');
  assertPositiveInteger(descriptor.height, 'Texture descriptor height');
  assertPositiveInteger(descriptor.depthOrArrayLayers, 'Texture descriptor depthOrArrayLayers');
  assertPositiveInteger(descriptor.mipLevelCount, 'Texture descriptor mipLevelCount');
  assertPositiveInteger(descriptor.sampleCount, 'Texture descriptor sampleCount');
}

function assertTextureRange(range: TextureRange, descriptor: TextureDescriptor): void {
  assertNonNegativeInteger(range.baseMipLevel, 'Texture range baseMipLevel');
  assertPositiveInteger(range.mipLevelCount, 'Texture range mipLevelCount');
  assertNonNegativeInteger(range.baseArrayLayer, 'Texture range baseArrayLayer');
  assertPositiveInteger(range.arrayLayerCount, 'Texture range arrayLayerCount');
  if (range.aspect !== 'all' && range.aspect !== 'depth-only' && range.aspect !== 'stencil-only') {
    throw new Error('Texture range aspect is invalid.');
  }
  assertTextureAspect(range.aspect, descriptor.format);
  if (range.baseMipLevel + range.mipLevelCount > descriptor.mipLevelCount) {
    throw new Error('Texture range mip levels are out of bounds.');
  }
  if (range.baseArrayLayer + range.arrayLayerCount > descriptor.depthOrArrayLayers) {
    throw new Error('Texture range array layers are out of bounds.');
  }
}

function assertTextureAspect(aspect: TextureRange['aspect'], format: string): void {
  if (aspect === 'all') return;
  const isDepthFormat = format.startsWith('depth');
  const isStencilFormat = format.includes('stencil');
  if (aspect === 'depth-only' && !isDepthFormat) {
    throw new Error(`Texture range aspect depth-only is incompatible with format "${format}".`);
  }
  if (aspect === 'stencil-only' && !isStencilFormat) {
    throw new Error(`Texture range aspect stencil-only is incompatible with format "${format}".`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
}

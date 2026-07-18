import type { BufferDescriptor, BufferRange, TextureDescriptor, TextureRange } from './types';

export interface TextureGraphRange extends TextureRange {
  readonly kind: 'texture';
  readonly mipLevelEnd: number;
  readonly arrayLayerEnd: number;
}

export interface BufferGraphRange extends BufferRange {
  readonly kind: 'buffer';
  readonly end: number;
}

export type GraphRange = TextureGraphRange | BufferGraphRange;

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

export function fullBufferRange(descriptor: BufferDescriptor): BufferGraphRange {
  return normalizeBufferRange(descriptor);
}

export function normalizeBufferRange(
  descriptor: BufferDescriptor,
  range?: BufferRange
): BufferGraphRange {
  assertBufferDescriptor(descriptor);
  const normalized = range ?? { offset: 0, size: descriptor.size };
  assertBufferRange(normalized, descriptor);

  return Object.freeze({
    kind: 'buffer' as const,
    offset: normalized.offset,
    size: normalized.size,
    end: normalized.offset + normalized.size
  });
}

export function textureRangesOverlap(first: TextureGraphRange, second: TextureGraphRange): boolean {
  return (
    rangesOverlapOnAxis(
      first.baseMipLevel,
      first.mipLevelEnd,
      second.baseMipLevel,
      second.mipLevelEnd
    ) &&
    rangesOverlapOnAxis(
      first.baseArrayLayer,
      first.arrayLayerEnd,
      second.baseArrayLayer,
      second.arrayLayerEnd
    ) &&
    aspectsOverlap(first.aspect, second.aspect)
  );
}

export function rangesOverlap(first: GraphRange, second: GraphRange): boolean {
  if (first.kind === 'texture' && second.kind === 'texture') {
    return textureRangesOverlap(first, second);
  }
  if (first.kind === 'buffer' && second.kind === 'buffer') {
    return rangesOverlapOnAxis(first.offset, first.end, second.offset, second.end);
  }
  return false;
}

function assertTextureDescriptor(descriptor: TextureDescriptor): void {
  assertPositiveInteger(descriptor.width, 'Texture descriptor width');
  assertPositiveInteger(descriptor.height, 'Texture descriptor height');
  assertPositiveInteger(descriptor.depthOrArrayLayers, 'Texture descriptor depthOrArrayLayers');
  assertPositiveInteger(descriptor.mipLevelCount, 'Texture descriptor mipLevelCount');
  assertPositiveInteger(descriptor.sampleCount, 'Texture descriptor sampleCount');
}

function assertBufferDescriptor(descriptor: BufferDescriptor): void {
  assertNonNegativeInteger(descriptor.size, 'Buffer descriptor size');
}

function assertTextureRange(range: TextureRange, descriptor: TextureDescriptor): void {
  assertNonNegativeInteger(range.baseMipLevel, 'Texture range baseMipLevel');
  assertPositiveInteger(range.mipLevelCount, 'Texture range mipLevelCount');
  assertNonNegativeInteger(range.baseArrayLayer, 'Texture range baseArrayLayer');
  assertPositiveInteger(range.arrayLayerCount, 'Texture range arrayLayerCount');
  if (range.aspect !== 'all' && range.aspect !== 'depth-only' && range.aspect !== 'stencil-only') {
    throw new Error('Texture range aspect is invalid.');
  }
  if (range.baseMipLevel + range.mipLevelCount > descriptor.mipLevelCount) {
    throw new Error('Texture range mip levels are out of bounds.');
  }
  if (range.baseArrayLayer + range.arrayLayerCount > descriptor.depthOrArrayLayers) {
    throw new Error('Texture range array layers are out of bounds.');
  }
}

function assertBufferRange(range: BufferRange, descriptor: BufferDescriptor): void {
  assertNonNegativeInteger(range.offset, 'Buffer range offset');
  assertNonNegativeInteger(range.size, 'Buffer range size');
  if (range.offset + range.size > descriptor.size) {
    throw new Error('Buffer range is out of bounds.');
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

function rangesOverlapOnAxis(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

function aspectsOverlap(first: TextureRange['aspect'], second: TextureRange['aspect']): boolean {
  return first === 'all' || second === 'all' || first === second;
}

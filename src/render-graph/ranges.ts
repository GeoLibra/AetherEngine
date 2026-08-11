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

export function intersectGraphRanges(first: GraphRange, second: GraphRange): GraphRange {
  if (!rangesOverlap(first, second)) throw new Error('Cannot intersect disjoint graph ranges.');
  if (first.kind === 'buffer' && second.kind === 'buffer') {
    const offset = Math.max(first.offset, second.offset);
    return bufferGraphRange(offset, Math.min(first.end, second.end));
  }
  if (first.kind === 'texture' && second.kind === 'texture') {
    return textureGraphRange(
      Math.max(first.baseMipLevel, second.baseMipLevel),
      Math.min(first.mipLevelEnd, second.mipLevelEnd),
      Math.max(first.baseArrayLayer, second.baseArrayLayer),
      Math.min(first.arrayLayerEnd, second.arrayLayerEnd),
      intersectAspect(first, second)
    );
  }
  throw new Error('Cannot intersect graph ranges of different resource kinds.');
}

export function subtractGraphRange(source: GraphRange, covered: GraphRange): GraphRange[] {
  if (!rangesOverlap(source, covered)) return [source];
  if (source.kind === 'buffer' && covered.kind === 'buffer') {
    const overlap = intersectGraphRanges(source, covered) as BufferGraphRange;
    const result: GraphRange[] = [];
    if (source.offset < overlap.offset)
      result.push(bufferGraphRange(source.offset, overlap.offset));
    if (overlap.end < source.end) result.push(bufferGraphRange(overlap.end, source.end));
    return result;
  }
  if (source.kind !== 'texture' || covered.kind !== 'texture') return [source];
  const overlap = intersectGraphRanges(source, covered) as TextureGraphRange;
  const result: GraphRange[] = [];
  if (source.baseMipLevel < overlap.baseMipLevel)
    result.push(
      textureGraphRange(
        source.baseMipLevel,
        overlap.baseMipLevel,
        source.baseArrayLayer,
        source.arrayLayerEnd,
        source.aspect
      )
    );
  if (overlap.mipLevelEnd < source.mipLevelEnd)
    result.push(
      textureGraphRange(
        overlap.mipLevelEnd,
        source.mipLevelEnd,
        source.baseArrayLayer,
        source.arrayLayerEnd,
        source.aspect
      )
    );
  if (source.baseArrayLayer < overlap.baseArrayLayer)
    result.push(
      textureGraphRange(
        overlap.baseMipLevel,
        overlap.mipLevelEnd,
        source.baseArrayLayer,
        overlap.baseArrayLayer,
        source.aspect
      )
    );
  if (overlap.arrayLayerEnd < source.arrayLayerEnd)
    result.push(
      textureGraphRange(
        overlap.baseMipLevel,
        overlap.mipLevelEnd,
        overlap.arrayLayerEnd,
        source.arrayLayerEnd,
        source.aspect
      )
    );
  return result;
}

export function atomizeTextureAspects(range: GraphRange, format: string): GraphRange[] {
  if (range.kind === 'buffer' || range.aspect !== 'all' || !format.startsWith('depth'))
    return [range];
  const depth = textureGraphRange(
    range.baseMipLevel,
    range.mipLevelEnd,
    range.baseArrayLayer,
    range.arrayLayerEnd,
    'depth-only'
  );
  return format.includes('stencil')
    ? [
        depth,
        textureGraphRange(
          range.baseMipLevel,
          range.mipLevelEnd,
          range.baseArrayLayer,
          range.arrayLayerEnd,
          'stencil-only'
        )
      ]
    : [depth];
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

function intersectAspect(
  first: TextureGraphRange,
  second: TextureGraphRange
): TextureGraphRange['aspect'] {
  if (first.aspect === 'all') return second.aspect;
  if (second.aspect === 'all') return first.aspect;
  return first.aspect;
}

function bufferGraphRange(offset: number, end: number): BufferGraphRange {
  return Object.freeze({ kind: 'buffer', offset, size: end - offset, end });
}

function textureGraphRange(
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

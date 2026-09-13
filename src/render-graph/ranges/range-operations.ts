import type { TextureRange } from '../types';
import type { BufferGraphRange, GraphRange, TextureGraphRange } from './types';
import { bufferGraphRange } from './buffer-ranges';
import { textureGraphRange } from './texture-ranges';

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

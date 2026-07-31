import type { RHICommandStats } from '../rhi/contracts';
import { normalizeBufferRange, normalizeTextureRange, type GraphRange } from './ranges';
import type { TextureGraphRange } from './ranges';
import type { GraphResourceRecord } from './resources';
import type { TransientAllocationDescriptor } from './transient-pool';
import type { BufferRange, BufferUsage, GraphHandle, TextureRange, TextureUsage } from './types';

export function allocationFor(resource: GraphResourceRecord): TransientAllocationDescriptor {
  if (resource.kind === 'buffer') {
    return {
      kind: 'buffer',
      descriptor: {
        ...(resource.descriptor.label === undefined ? {} : { label: resource.descriptor.label }),
        size: resource.descriptor.size,
        usage: bufferUsageFlags(resource.descriptor.usage)
      }
    };
  }
  return {
    kind: 'texture',
    descriptor: {
      ...(resource.descriptor.label === undefined ? {} : { label: resource.descriptor.label }),
      size: {
        width: resource.descriptor.width,
        height: resource.descriptor.height,
        depthOrArrayLayers: resource.descriptor.depthOrArrayLayers
      },
      format: resource.descriptor.format,
      usage: textureUsageFlags(resource.descriptor.usage),
      mipLevelCount: resource.descriptor.mipLevelCount,
      sampleCount: resource.descriptor.sampleCount
    }
  };
}

export function freezeCommandStats(stats: RHICommandStats): RHICommandStats {
  return Object.freeze({
    ...stats,
    draw: Object.freeze({ ...stats.draw }),
    compute: Object.freeze({ ...stats.compute }),
    copy: Object.freeze({ ...stats.copy })
  });
}

export function normalizeRequestedRange(
  handle: GraphHandle,
  requested: TextureRange | BufferRange | undefined,
  declared: GraphRange
): GraphRange {
  if (requested === undefined) return declared;
  if (handle.kind === 'buffer') {
    return normalizeBufferRange(
      { size: declared.kind === 'buffer' ? declared.end : 0, usage: [] },
      requested as BufferRange | undefined
    );
  }
  return normalizeTextureRange(
    {
      width: 1,
      height: 1,
      depthOrArrayLayers: declared.kind === 'texture' ? declared.arrayLayerEnd : 1,
      mipLevelCount: declared.kind === 'texture' ? declared.mipLevelEnd : 1,
      sampleCount: 1,
      format:
        declared.kind === 'texture' && declared.aspect !== 'all'
          ? 'depth24plus-stencil8'
          : 'rgba8unorm',
      usage: []
    },
    requested as TextureRange | undefined
  );
}

export function containsRange(declared: GraphRange, requested: GraphRange): boolean {
  if (declared.kind === 'buffer' && requested.kind === 'buffer') {
    return declared.offset <= requested.offset && requested.end <= declared.end;
  }
  if (declared.kind === 'texture' && requested.kind === 'texture') {
    const aspect = declared.aspect === 'all' || declared.aspect === requested.aspect;
    return (
      declared.baseMipLevel <= requested.baseMipLevel &&
      requested.mipLevelEnd <= declared.mipLevelEnd &&
      declared.baseArrayLayer <= requested.baseArrayLayer &&
      requested.arrayLayerEnd <= declared.arrayLayerEnd &&
      aspect
    );
  }
  return false;
}

export function toViewDescriptor(range: TextureGraphRange) {
  return {
    baseMipLevel: range.baseMipLevel,
    mipLevelCount: range.mipLevelCount,
    baseArrayLayer: range.baseArrayLayer,
    arrayLayerCount: range.arrayLayerCount,
    // Native RHI ports accept the portable WebGPU aspect field even though public RHI views are opaque.
    aspect: range.aspect
  };
}

function textureUsageFlags(usages: readonly TextureUsage[]): number {
  const flags: Record<TextureUsage, number> = {
    'copy-src': 1 << 0,
    'copy-dst': 1 << 1,
    sampled: 1 << 2,
    'storage-read': 1 << 3,
    'storage-write': 1 << 3,
    'color-attachment': 1 << 4,
    'depth-stencil-attachment': 1 << 4
  };
  return usages.reduce((value, usage) => value | flags[usage], 0);
}

function bufferUsageFlags(usages: readonly BufferUsage[]): number {
  const flags: Record<BufferUsage, number> = {
    'copy-src': 1 << 2,
    'copy-dst': 1 << 3,
    index: 1 << 4,
    vertex: 1 << 5,
    uniform: 1 << 6,
    'storage-read': 1 << 7,
    'storage-write': 1 << 7,
    indirect: 1 << 8,
    'query-resolve': 1 << 9
  };
  return usages.reduce((value, usage) => value | flags[usage], 0);
}

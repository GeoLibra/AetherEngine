import { describe, expect, test } from 'vitest';
import {
  fullBufferRange,
  fullTextureRange,
  normalizeBufferRange,
  normalizeTextureRange,
  rangesOverlap,
  textureRangesOverlap
} from '../../src/render-graph/ranges';
import type { BufferDescriptor, TextureDescriptor } from '../../src/render-graph/types';

const textureDescriptor: TextureDescriptor = {
  label: 'mip-chain',
  width: 32,
  height: 16,
  depthOrArrayLayers: 4,
  mipLevelCount: 5,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment']
};

const bufferDescriptor: BufferDescriptor = {
  label: 'vertices',
  size: 64,
  usage: ['vertex', 'copy-dst']
};

describe('render graph ranges', () => {
  test('recognizes whole and partial texture overlap', () => {
    const whole = fullTextureRange(textureDescriptor);
    const mipTwo = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 2,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 4,
      aspect: 'all'
    });

    expect(textureRangesOverlap(whole, mipTwo)).toBe(true);
    expect(Object.isFrozen(whole)).toBe(true);
  });

  test('distinguishes disjoint mip, layer, and aspect selections', () => {
    const mipOne = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 1,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
      aspect: 'all'
    });
    const mipTwo = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 2,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
      aspect: 'all'
    });
    const layerOne = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 1,
      mipLevelCount: 1,
      baseArrayLayer: 1,
      arrayLayerCount: 1,
      aspect: 'all'
    });
    const depth = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 1,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
      aspect: 'depth-only'
    });
    const stencil = normalizeTextureRange(textureDescriptor, {
      baseMipLevel: 1,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
      aspect: 'stencil-only'
    });

    expect(textureRangesOverlap(mipOne, mipTwo)).toBe(false);
    expect(textureRangesOverlap(mipOne, layerOne)).toBe(false);
    expect(textureRangesOverlap(depth, stencil)).toBe(false);
  });

  test('uses half-open byte intervals at buffer boundaries', () => {
    const left = normalizeBufferRange(bufferDescriptor, { offset: 0, size: 16 });
    const adjacent = normalizeBufferRange(bufferDescriptor, { offset: 16, size: 16 });
    const overlapping = normalizeBufferRange(bufferDescriptor, { offset: 15, size: 2 });

    expect(rangesOverlap(left, adjacent)).toBe(false);
    expect(rangesOverlap(left, overlapping)).toBe(true);
    expect(fullBufferRange(bufferDescriptor)).toMatchObject({
      kind: 'buffer',
      offset: 0,
      size: 64,
      end: 64
    });
  });

  test.each([
    () =>
      normalizeTextureRange(textureDescriptor, {
        ...fullTextureRange(textureDescriptor),
        baseMipLevel: -1
      }),
    () =>
      normalizeTextureRange(textureDescriptor, {
        ...fullTextureRange(textureDescriptor),
        mipLevelCount: 6
      }),
    () =>
      normalizeTextureRange(textureDescriptor, {
        ...fullTextureRange(textureDescriptor),
        arrayLayerCount: 5
      }),
    () => normalizeBufferRange(bufferDescriptor, { offset: -1, size: 1 }),
    () => normalizeBufferRange(bufferDescriptor, { offset: 63, size: 2 })
  ])('rejects negative or out-of-bounds ranges', (normalize) => {
    expect(normalize).toThrow(/range/i);
  });
});

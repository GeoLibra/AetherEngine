import { describe, expect, test } from 'vitest';
import { webgpuCompat } from '../src';

describe('webgpuCompat', () => {
  test('normalizes and freezes pure buffer descriptors', () => {
    const input = { label: 'upload', size: 64, usage: 8 };
    const descriptor = webgpuCompat.bufferDescriptor(input);
    input.size = 128;

    expect(descriptor).toEqual({
      label: 'upload',
      size: 64,
      usage: 8,
      mappedAtCreation: false
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  test('normalizes texture extent and WebGPU defaults into immutable values', () => {
    const size = { width: 32, height: 16 };
    const descriptor = webgpuCompat.textureDescriptor({
      size,
      format: 'rgba8unorm',
      usage: 16
    });
    size.width = 1;

    expect(descriptor).toEqual({
      size: { width: 32, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 16,
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.size)).toBe(true);
  });

  test('normalizes pure sampler defaults without DOM WebGPU objects', () => {
    expect(webgpuCompat.samplerDescriptor({ label: 'linear', magFilter: 'linear' })).toEqual({
      label: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      lodMinClamp: 0,
      lodMaxClamp: 32,
      maxAnisotropy: 1
    });
  });

  test('rejects unknown native-bearing fields with a field diagnostic', () => {
    expect(() => webgpuCompat.bufferDescriptor({
      size: 64,
      usage: 8,
      buffer: { native: true }
    } as never)).toThrow('WebGPU buffer descriptor field "buffer" is not portable.');
  });

  test('rejects descriptors whose meaning depends on resource identity', () => {
    expect(() => webgpuCompat.bindGroupDescriptor({ layout: {}, entries: [] })).toThrow(
      'WebGPU bind-group descriptors contain resource identities and cannot be converted automatically.'
    );
    expect(() => webgpuCompat.renderPassDescriptor({ colorAttachments: [] })).toThrow(
      'WebGPU render-pass descriptors contain resource identities and cannot be converted automatically.'
    );
  });
});

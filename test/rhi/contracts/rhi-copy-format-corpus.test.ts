import { describe, expect, test } from 'vitest';

import { NullDevice } from '../../../src/rhi';

// Independent contract fixtures: do not derive expected byte counts from production layouts.
const FORMAT_CASES = [
  ['r8unorm', 1, 1],
  ['r8snorm', 1, 1],
  ['r8uint', 1, 1],
  ['r8sint', 1, 1],
  ['rg8unorm', 1, 2],
  ['rg8snorm', 1, 2],
  ['rgba8unorm', 1, 4],
  ['rgba8unorm-srgb', 1, 4],
  ['bgra8unorm', 1, 4],
  ['bgra8unorm-srgb', 1, 4],
  ['rgba16float', 1, 8],
  ['rgba32float', 1, 16],
  ['rgba32uint', 1, 16],
  ['bc1-rgba-unorm', 4, 8],
  ['bc1-rgba-unorm-srgb', 4, 8],
  ['bc3-rgba-unorm', 4, 16],
  ['bc3-rgba-unorm-srgb', 4, 16]
] as const;

const DIRECTIONS = ['buffer-to-texture', 'texture-to-buffer'] as const;

describe('registered portable copy format corpus', () => {
  describe.each(FORMAT_CASES)('%s', (format, blockDimension, blockBytes) => {
    test.each(DIRECTIONS)(
      '%s includes padded images but only the final row payload',
      (direction) => {
        const device = new NullDevice();
        const texture = device.createTexture({
          size: [2 * blockDimension, 2 * blockDimension, 2],
          format,
          usage: 3
        });
        // Two block rows per layer, three padded rows between layers, and a nonzero offset.
        const requiredBytes = 4 + 3 * 256 + 256 + 2 * blockBytes;
        const bufferUsage = direction === 'buffer-to-texture' ? 4 : 8;
        const exact = device.createBuffer({
          size: Math.ceil(requiredBytes / 4) * 4,
          usage: bufferUsage
        });
        const short = device.createBuffer({
          size: Math.floor((requiredBytes - 1) / 4) * 4,
          usage: bufferUsage
        });
        const encoder = device.createCommandEncoder();
        const extent = [2 * blockDimension, 2 * blockDimension, 2] as const;
        const layout = { offset: 4, bytesPerRow: 256, rowsPerImage: 3 };
        if (direction === 'buffer-to-texture') {
          encoder.copyBufferToTexture({ buffer: exact, ...layout }, { texture }, extent);
          expect(() =>
            encoder.copyBufferToTexture({ buffer: short, ...layout }, { texture }, extent)
          ).toThrow(`requires buffer range 4..${requiredBytes} outside buffer size ${short.size}`);
        } else {
          encoder.copyTextureToBuffer({ texture }, { buffer: exact, ...layout }, extent);
          expect(() =>
            encoder.copyTextureToBuffer({ texture }, { buffer: short, ...layout }, extent)
          ).toThrow(`requires buffer range 4..${requiredBytes} outside buffer size ${short.size}`);
        }
        const commands = encoder.finish();
        expect(commands.getCommandStream()).toHaveLength(1);
        expect(commands.getStats().copy).toMatchObject(
          direction === 'buffer-to-texture'
            ? { copyBufferToTexture: 1 }
            : { copyTextureToBuffer: 1 }
        );
      }
    );
  });

  test('rejects unregistered byte layouts without recording a command', () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({ size: 256, usage: 12 });
    const texture = device.createTexture({ size: [1, 1], format: 'depth32float', usage: 3 });
    const encoder = device.createCommandEncoder();
    expect(() =>
      encoder.copyBufferToTexture({ buffer, bytesPerRow: 256 }, { texture }, [1, 1])
    ).toThrow('has no portable copy block layout');
    expect(() =>
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1])
    ).toThrow('has no portable copy block layout');
    expect(encoder.finish().getCommandStream()).toHaveLength(0);
  });
});

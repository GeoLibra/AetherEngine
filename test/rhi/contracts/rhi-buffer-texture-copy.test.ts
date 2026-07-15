import { describe, expect, test } from 'vitest';

import { NullDevice } from '../../../src/rhi';

const BUFFER_COPY_SRC = 1 << 2;
const BUFFER_COPY_DST = 1 << 3;
const TEXTURE_COPY_SRC = 1 << 0;
const TEXTURE_COPY_DST = 1 << 1;

describe('RHI buffer-texture copy contract', () => {
  test('records both directions with normalized layout and stats', () => {
    const device = new NullDevice();
    const upload = device.createBuffer({ label: 'upload', size: 1024, usage: BUFFER_COPY_SRC });
    const readback = device.createBuffer({ label: 'readback', size: 1024, usage: BUFFER_COPY_DST });
    const texture = device.createTexture({
      label: 'pixels', size: [4, 2], format: 'rgba8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const encoder = device.createCommandEncoder();

    encoder.copyBufferToTexture(
      { buffer: upload, offset: 0, bytesPerRow: 256, rowsPerImage: 2 },
      { texture },
      { width: 4, height: 2 }
    );
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, offset: 0, bytesPerRow: 256, rowsPerImage: 2 },
      { width: 4, height: 2 }
    );

    const commands = encoder.finish();
    expect(commands.getStats().copy).toEqual({
      copyBufferToBuffer: 0,
      copyTextureToTexture: 0,
      copyBufferToTexture: 1,
      copyTextureToBuffer: 1
    });
    expect(commands.getCommandStream().map(({ kind }) => kind)).toEqual([
      'copyBufferToTexture', 'copyTextureToBuffer'
    ]);
  });

  test('rejects invalid row alignment, usage, and buffer range', () => {
    const device = new NullDevice();
    const wrongUsage = device.createBuffer({ label: 'wrong', size: 1024, usage: BUFFER_COPY_DST });
    const small = device.createBuffer({ label: 'small', size: 256, usage: BUFFER_COPY_SRC });
    const texture = device.createTexture({
      label: 'pixels', size: [4, 2], format: 'rgba8unorm', usage: TEXTURE_COPY_DST
    });
    const encoder = device.createCommandEncoder();

    expect(() => encoder.copyBufferToTexture(
      { buffer: small, bytesPerRow: 16 }, { texture }, [4, 2]
    )).toThrow('bytesPerRow 16 must be a multiple of 256');
    expect(() => encoder.copyBufferToTexture(
      { buffer: wrongUsage, bytesPerRow: 256 }, { texture }, [4, 2]
    )).toThrow('Buffer "wrong" requires COPY_SRC usage');
    expect(() => encoder.copyBufferToTexture(
      { buffer: small, bytesPerRow: 256 }, { texture }, [4, 2]
    )).toThrow('requires buffer range 0..272 outside buffer size 256');
  });

  test('validates compressed texture block boundaries', () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({ size: 1024, usage: BUFFER_COPY_SRC });
    const texture = device.createTexture({
      size: [8, 8], format: 'bc1-rgba-unorm', usage: TEXTURE_COPY_DST
    });
    const encoder = device.createCommandEncoder();

    expect(() => encoder.copyBufferToTexture(
      { buffer, bytesPerRow: 256 }, { texture, origin: [2, 0] }, [4, 4]
    )).toThrow('Texture copy origin must align to 4x4 format blocks.');
  });
});

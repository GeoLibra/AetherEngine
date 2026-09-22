import { describe, expect, test } from 'vitest';

import { NullDevice } from '../../../src/rhi';

const BUFFER_USAGE_COPY_SRC = 1 << 2;
const BUFFER_USAGE_COPY_DST = 1 << 3;
const TEXTURE_USAGE_COPY_SRC = 1 << 0;
const TEXTURE_USAGE_COPY_DST = 1 << 1;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 1 << 4;

describe('RHI queue uploads', () => {
  test('writes buffer bytes through writeBuffer and writeBufferRanges', async () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({
      label: 'upload-target',
      size: 16,
      usage: BUFFER_USAGE_COPY_DST
    });

    device.queue.writeBuffer(buffer, 4, new Uint8Array([1, 2, 3, 4]));
    device.queue.writeBufferRanges(buffer, [
      { offset: 8, data: new Uint8Array([5, 6]) },
      { offset: 10, data: new Uint8Array([7, 8]).buffer }
    ]);

    await buffer.mapAsync(0);

    expect(Array.from(new Uint8Array(buffer.getMappedRange(4, 8)))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8
    ]);
    expect(device.queue.metrics()).toMatchObject({ uploadCalls: 3, uploadBytes: 8 });
  });

  test('validates all writeBufferRanges entries before mutating storage', async () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({
      label: 'atomic-upload',
      size: 8,
      usage: BUFFER_USAGE_COPY_DST
    });

    expect(() =>
      device.queue.writeBufferRanges(buffer, [
        { offset: 0, data: new Uint8Array([1, 2, 3, 4]) },
        { offset: 7, data: new Uint8Array([5, 6]) }
      ])
    ).toThrow('Buffer range 7..9 is outside buffer size 8.');

    await buffer.mapAsync(0);

    expect(Array.from(new Uint8Array(buffer.getMappedRange()))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('rejects invalid buffer upload resources and mapped buffers', async () => {
    const device = new NullDevice();
    const foreignDevice = new NullDevice();
    const buffer = device.createBuffer({
      label: 'upload-target',
      size: 8,
      usage: BUFFER_USAGE_COPY_DST
    });
    const foreign = foreignDevice.createBuffer({
      label: 'foreign-upload-target',
      size: 8,
      usage: BUFFER_USAGE_COPY_DST
    });

    expect(() => device.queue.writeBuffer(foreign, 0, new Uint8Array([1]))).toThrow(
      'Resource "foreign-upload-target" belongs to a different NullDevice.'
    );

    await buffer.mapAsync(0);

    expect(() => device.queue.writeBuffer(buffer, 0, new Uint8Array([1]))).toThrow(
      'Buffer "upload-target" is currently mapped.'
    );

    buffer.unmap();
    buffer.dispose();

    expect(() => device.queue.writeBuffer(buffer, 0, new Uint8Array([1]))).toThrow(
      'Resource "upload-target" has been disposed.'
    );
  });

  test('validates texture upload destination bounds using mip size', () => {
    const device = new NullDevice();
    const texture = device.createTexture({
      label: 'upload-texture',
      size: { width: 16, height: 16 },
      mipLevelCount: 4,
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_DST
    });

    expect(() =>
      device.queue.writeTexture(
        { texture, mipLevel: 2 },
        new Uint8Array(4 * 4 * 4),
        { offset: 0, bytesPerRow: 16, rowsPerImage: 4 },
        { width: 4, height: 4 }
      )
    ).not.toThrow();

    expect(() =>
      device.queue.writeTexture(
        { texture, mipLevel: 2 },
        new Uint8Array(8 * 8 * 4),
        { offset: 0, bytesPerRow: 32, rowsPerImage: 8 },
        { width: 8, height: 8 }
      )
    ).toThrow('Texture copy range exceeds texture "upload-texture" mip level 2 bounds 4x4x1.');
    expect(device.queue.metrics()).toMatchObject({ uploadCalls: 1, uploadBytes: 64 });
  });

  test('keeps 2d array texture layers available across mip levels', () => {
    const device = new NullDevice();
    const texture = device.createTexture({
      label: 'array-texture',
      size: { width: 16, height: 16, depthOrArrayLayers: 4 },
      dimension: '2d',
      mipLevelCount: 4,
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST
    });

    expect(() =>
      device.queue.writeTexture(
        { texture, mipLevel: 2, origin: { z: 2 } },
        new Uint8Array(4 * 4 * 2 * 4),
        { offset: 0, bytesPerRow: 16, rowsPerImage: 4 },
        { width: 4, height: 4, depthOrArrayLayers: 2 }
      )
    ).not.toThrow();

    const encoder = device.createCommandEncoder();

    expect(() =>
      encoder.copyTextureToTexture(
        { texture, mipLevel: 2, origin: { z: 2 } },
        { texture, mipLevel: 2, origin: [0, 0, 0] },
        { width: 4, height: 4, depthOrArrayLayers: 2 }
      )
    ).not.toThrow();
  });
});

describe('RHI copy command encoding', () => {
  test('records buffer and texture copy commands with copy stats', () => {
    const device = new NullDevice();
    const source = device.createBuffer({
      label: 'copy-source',
      size: 32,
      usage: BUFFER_USAGE_COPY_SRC
    });
    const destination = device.createBuffer({
      label: 'copy-destination',
      size: 32,
      usage: BUFFER_USAGE_COPY_DST
    });
    const sourceTexture = device.createTexture({
      label: 'copy-source-texture',
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_SRC
    });
    const destinationTexture = device.createTexture({
      label: 'copy-destination-texture',
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_DST
    });
    const encoder = device.createCommandEncoder({ label: 'copies' });

    encoder.copyBufferToBuffer(source, 4, destination, 8, 12);
    encoder.copyTextureToTexture(
      { texture: sourceTexture, origin: { x: 1, y: 1 } },
      { texture: destinationTexture, origin: [2, 2, 0] },
      { width: 4, height: 4 }
    );

    const commandBuffer = encoder.finish();

    expect(commandBuffer.getStats().copy).toEqual({
      copyBufferToBuffer: 1,
      copyTextureToTexture: 1,
      copyBufferToTexture: 0,
      copyTextureToBuffer: 0
    });
    expect(commandBuffer.getCommandStream()).toEqual([
      {
        kind: 'copyBufferToBuffer',
        source: { kind: 'buffer', id: source.id, label: 'copy-source' },
        sourceOffset: 4,
        destination: { kind: 'buffer', id: destination.id, label: 'copy-destination' },
        destinationOffset: 8,
        size: 12
      },
      {
        kind: 'copyTextureToTexture',
        source: {
          texture: { kind: 'texture', id: sourceTexture.id, label: 'copy-source-texture' },
          mipLevel: 0,
          origin: { x: 1, y: 1, z: 0 },
          aspect: 'all'
        },
        destination: {
          texture: {
            kind: 'texture',
            id: destinationTexture.id,
            label: 'copy-destination-texture'
          },
          mipLevel: 0,
          origin: { x: 2, y: 2, z: 0 },
          aspect: 'all'
        },
        copySize: { width: 4, height: 4, depthOrArrayLayers: 1 }
      }
    ]);
  });

  test('rejects buffer copies while a pass is active or a buffer is mapped', async () => {
    const device = new NullDevice();
    const source = device.createBuffer({ label: 'source', size: 16, usage: BUFFER_USAGE_COPY_SRC });
    const destination = device.createBuffer({
      label: 'destination',
      size: 16,
      usage: BUFFER_USAGE_COPY_DST
    });
    const encoder = device.createCommandEncoder();
    const target = device.createTexture({
      label: 'color',
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    expect(() => encoder.copyBufferToBuffer(source, 0, destination, 0, 4)).toThrow(
      'Cannot copy buffers while a pass is active.'
    );

    pass.end();
    await source.mapAsync(0);

    expect(() => encoder.copyBufferToBuffer(source, 0, destination, 0, 4)).toThrow(
      'Buffer "source" is currently mapped.'
    );
  });

  test('validates texture copy bounds and active pass state', () => {
    const device = new NullDevice();
    const texture = device.createTexture({
      label: 'texture',
      size: { width: 16, height: 16 },
      mipLevelCount: 4,
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    expect(() =>
      encoder.copyTextureToTexture({ texture }, { texture }, { width: 1, height: 1 })
    ).toThrow('Cannot copy textures while a pass is active.');

    pass.end();

    expect(() =>
      encoder.copyTextureToTexture(
        { texture, mipLevel: 2 },
        { texture, mipLevel: 2 },
        { width: 8, height: 8 }
      )
    ).toThrow('Texture copy range exceeds texture "texture" mip level 2 bounds 4x4x1.');
  });
});

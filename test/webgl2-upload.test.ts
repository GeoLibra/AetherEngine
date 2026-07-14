import { describe, expect, test } from 'vitest';

import { WebGL2Adapter, type WebGL2NativeContextLostInfo } from '../src';

interface NativeObject { readonly id: number; readonly kind: 'buffer' | 'texture' }

class UploadContext {
  readonly info = { name: 'Upload WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly bufferWrites: Array<{ handle: NativeObject; offset: number; bytes: Uint8Array }> = [];
  readonly textureWrites: Array<{ destination: Readonly<Record<string, unknown>>; bytes: Uint8Array }> = [];
  private nextId = 1;

  createBuffer(): NativeObject { return { id: this.nextId++, kind: 'buffer' }; }
  createTexture(): NativeObject { return { id: this.nextId++, kind: 'texture' }; }
  createSampler(): NativeObject { throw new Error('unused'); }
  deleteBuffer(): void {}
  deleteTexture(): void {}
  deleteSampler(): void {}
  writeBuffer(handle: NativeObject, offset: number, bytes: ArrayBufferView): void {
    this.bufferWrites.push({
      handle, offset, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    });
  }
  writeTexture(
    destination: Readonly<Record<string, unknown>>,
    bytes: ArrayBufferView
  ): void {
    this.textureWrites.push({
      destination, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    });
  }
}

async function createDevice(native = new UploadContext()) {
  const device = await new WebGL2Adapter(native).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  return { device, native };
}

describe('WebGL2 queue uploads', () => {
  test('copies buffer upload bytes and validates a full range batch before mutation', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ label: 'upload', size: 12, usage: 8 });
    const input = new Uint8Array([1, 2, 3, 4]);

    device.queue.writeBuffer(buffer, 0, input);
    input[0] = 9;
    expect([...native.bufferWrites[0]!.bytes]).toEqual([1, 2, 3, 4]);

    expect(() => device.queue.writeBufferRanges(buffer, [
      { offset: 4, data: new Uint8Array([5, 6]) },
      { offset: 11, data: new Uint8Array([7, 8]) }
    ])).toThrow('Buffer range 11..13 is outside buffer size 12.');
    expect(native.bufferWrites).toHaveLength(1);
  });

  test('rejects foreign and disposed upload buffers before native calls', async () => {
    const first = await createDevice();
    const second = await createDevice(first.native);
    const foreign = second.device.createBuffer({ label: 'foreign', size: 8, usage: 8 });

    expect(() => first.device.queue.writeBuffer(foreign, 0, new Uint8Array([1]))).toThrow(
      'Resource "foreign" belongs to a different WebGL2Device.'
    );
    foreign.dispose();
    expect(() => second.device.queue.writeBuffer(foreign, 0, new Uint8Array([1]))).toThrow(
      'Resource "foreign" has been disposed.'
    );
    expect(first.native.bufferWrites).toHaveLength(0);
  });

  test('validates texture mip bounds and lowers the native destination', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({
      label: 'texture', size: [8, 8], mipLevelCount: 2, format: 'rgba8unorm', usage: 2
    });

    device.queue.writeTexture(
      { texture, mipLevel: 1 },
      new Uint8Array(4 * 4 * 4),
      { bytesPerRow: 16, rowsPerImage: 4 },
      [4, 4]
    );
    expect(native.textureWrites[0]?.destination).toMatchObject({ mipLevel: 1 });
    expect(native.textureWrites[0]?.destination.texture).not.toBe(texture);

    expect(() => device.queue.writeTexture(
      { texture, mipLevel: 1 }, new Uint8Array(8 * 8 * 4),
      { bytesPerRow: 32, rowsPerImage: 8 }, [8, 8]
    )).toThrow('Texture copy range exceeds texture "texture" mip level 1 bounds 4x4x1.');
    expect(native.textureWrites).toHaveLength(1);
  });
});

import { describe, expect, test } from 'vitest';

import {
  WebGPUAdapter,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeBufferPort,
  type WebGPUNativeDeviceLostInfo,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeImportTexturePort,
  type WebGPUNativeQueuePort,
  type WebGPUNativeResourcePort
} from '../src';

const COPY_DST = 1 << 3;

class NativeBuffer implements WebGPUNativeBufferPort {
  readonly size: number;
  readonly usage: number;
  constructor(descriptor: Readonly<Record<string, unknown>>) {
    this.size = descriptor.size as number;
    this.usage = descriptor.usage as number;
  }
}

class NativeTexture implements WebGPUNativeImportTexturePort {
  readonly width = 8;
  readonly height = 8;
  readonly depthOrArrayLayers = 1;
  readonly format = 'rgba8unorm';
  readonly usage = COPY_DST;
  readonly dimension = '2d';
  readonly mipLevelCount = 2;
  readonly sampleCount = 1;
  createView(): WebGPUNativeResourcePort { return {}; }
}

class NativeQueue implements WebGPUNativeQueuePort {
  readonly bufferWrites: Array<{ buffer: WebGPUNativeResourcePort; offset: number; bytes: Uint8Array }> = [];
  readonly textureWrites: Array<{ destination: Readonly<Record<string, unknown>>; bytes: Uint8Array }> = [];
  submit(): void {}
  onSubmittedWorkDone(): Promise<void> { return Promise.resolve(); }
  writeBuffer(buffer: WebGPUNativeResourcePort, offset: number, data: ArrayBufferView): void {
    this.bufferWrites.push({ buffer, offset, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  }
  writeTexture(destination: Readonly<Record<string, unknown>>, data: ArrayBufferView): void {
    this.textureWrites.push({
      destination,
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    });
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly queue = new NativeQueue();
  readonly lost = new Promise<WebGPUNativeDeviceLostInfo>(() => {});
  createBuffer(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeBufferPort {
    return new NativeBuffer(descriptor);
  }
  createTexture(): NativeTexture { return new NativeTexture(); }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Upload Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly device = new NativeDevice();
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> { return this.device; }
}

async function createDevice() {
  const adapter = new NativeAdapter();
  const device = await new WebGPUAdapter(adapter).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  return { device, native: adapter.device };
}

describe('WebGPU queue uploads', () => {
  test('forwards buffer writes directly after validating the complete range batch', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ label: 'upload', size: 16, usage: COPY_DST });

    device.queue.writeBuffer(buffer, 4, new Uint8Array([1, 2, 3, 4]));
    device.queue.writeBufferRanges(buffer, [
      { offset: 8, data: new Uint8Array([5, 6]) },
      { offset: 10, data: new Uint8Array([7, 8]).buffer }
    ]);

    expect(native.queue.bufferWrites.map(({ offset, bytes }) => [offset, ...bytes])).toEqual([
      [4, 1, 2, 3, 4],
      [8, 5, 6],
      [10, 7, 8]
    ]);

    expect(() => device.queue.writeBufferRanges(buffer, [
      { offset: 0, data: new Uint8Array([9]) },
      { offset: 16, data: new Uint8Array([9]) }
    ])).toThrow('Buffer range 16..17 is outside buffer size 16.');
    expect(native.queue.bufferWrites).toHaveLength(3);
  });

  test('lowers and forwards texture writes after mip-bound validation', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({
      label: 'upload-texture',
      size: [8, 8],
      mipLevelCount: 2,
      format: 'rgba8unorm',
      usage: COPY_DST
    });

    device.queue.writeTexture(
      { texture, mipLevel: 1, origin: [0, 0, 0] },
      new Uint8Array(4 * 4 * 4),
      { bytesPerRow: 16, rowsPerImage: 4 },
      [4, 4, 1]
    );

    expect(native.queue.textureWrites).toHaveLength(1);
    expect(native.queue.textureWrites[0]?.destination).toMatchObject({ mipLevel: 1 });
    expect(native.queue.textureWrites[0]?.destination.texture).not.toBe(texture);
    expect(() => device.queue.writeTexture(
      { texture, mipLevel: 1 },
      new Uint8Array(8 * 8 * 4),
      { bytesPerRow: 32, rowsPerImage: 8 },
      [8, 8, 1]
    )).toThrow('Texture copy range exceeds texture "upload-texture" mip level 1 bounds 4x4x1.');
    expect(native.queue.textureWrites).toHaveLength(1);
  });

  test('reports direct fast-path counters without command replay allocations', async () => {
    const { device } = await createDevice();
    const buffer = device.createBuffer({ size: 8, usage: COPY_DST });
    device.queue.writeBuffer(buffer, 0, new Uint8Array([1, 2, 3, 4]));

    expect(device.fastPathMetrics()).toMatchObject({
      uploadCalls: 1,
      uploadBytes: 4,
      commandReplayRecordAllocations: 0
    });
  });
});

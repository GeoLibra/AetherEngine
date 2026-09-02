import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  WebGPUAdapter,
  WebGPUInteropExtension,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeComputePassPort,
  type WebGPUNativeDeviceLostInfo,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeRenderPassPort,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort
} from '../../../src';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class NativeBuffer implements WebGPUNativeResourcePort {
  destroyed = 0;
  constructor(
    readonly size: number,
    readonly usage: number
  ) {}
  destroy(): void {
    this.destroyed += 1;
  }
}

class NativeTexture implements WebGPUNativeTexturePort {
  destroyed = 0;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly depthOrArrayLayers: number,
    readonly format: string,
    readonly usage: number,
    readonly dimension = '2d',
    readonly mipLevelCount = 1,
    readonly sampleCount = 1
  ) {}
  createView(): WebGPUNativeResourcePort {
    return {};
  }
  destroy(): void {
    this.destroyed += 1;
  }
}

class EmptyRenderPass implements WebGPUNativeRenderPassPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  setVertexBuffer(): void {}
  setIndexBuffer(): void {}
  setViewport(): void {}
  setScissorRect(): void {}
  draw(): void {}
  drawIndexed(): void {}
  drawIndirect(): void {}
  end(): void {}
}

class EmptyComputePass implements WebGPUNativeComputePassPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  dispatchWorkgroups(): void {}
  dispatchWorkgroupsIndirect(): void {}
  end(): void {}
}

class NativeEncoder implements WebGPUNativeCommandEncoderPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  beginRenderPass(): WebGPUNativeRenderPassPort {
    return new EmptyRenderPass();
  }
  beginComputePass(): WebGPUNativeComputePassPort {
    return new EmptyComputePass();
  }
  copyBufferToBuffer(): void {}
  copyTextureToTexture(): void {}
  finish(): WebGPUNativeResourcePort {
    return {};
  }
}

class NativeQueue {
  private readonly completions: Deferred<void>[] = [];
  submit(): void {}
  onSubmittedWorkDone(): Promise<void> {
    const completion = deferred<void>();
    this.completions.push(completion);
    return completion.promise;
  }
  complete(index: number): void {
    const completion = this.completions[index];
    if (completion === undefined) throw new Error(`Missing completion ${index}.`);
    completion.resolve(undefined);
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly queue = new NativeQueue();
  readonly encoders: NativeEncoder[] = [];
  private readonly loss = deferred<WebGPUNativeDeviceLostInfo>();
  readonly lost = this.loss.promise;
  createBuffer(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    return new NativeBuffer(descriptor.size as number, descriptor.usage as number);
  }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    const encoder = new NativeEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
  lose(info: WebGPUNativeDeviceLostInfo): void {
    this.loss.resolve(info);
  }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Interop Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly device = new NativeDevice();
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    return this.device;
  }
}

async function createDevice() {
  const adapter = new NativeAdapter();
  const device = await new WebGPUAdapter(adapter).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  const interop = device.getExtension(WebGPUInteropExtension);
  if (interop === undefined) throw new Error('Expected WebGPU interop extension.');
  return { device, native: adapter.device, interop };
}

describe('WebGPU controlled native interop', () => {
  test('exposes a typed WebGPU-only extension without queue or surface methods on scopes', async () => {
    const { native, interop } = await createDevice();
    const scope = interop.createScope('native-pass-plugin');

    expect(interop.deviceGeneration).toBeGreaterThan(0);
    expect(scope.owner).toBe('native-pass-plugin');
    expect(scope.device).toBe(native);
    expect(scope).not.toHaveProperty('queue');
    expect(scope).not.toHaveProperty('submit');
    expect(scope).not.toHaveProperty('surface');
    expect(scope).not.toHaveProperty('getCurrentTexture');
    expect(new NullDevice().getExtension(WebGPUInteropExtension)).toBeUndefined();
    expect(() => interop.createScope('')).toThrow('Interop scope owner must not be empty.');
    expect(() => interop.createScope('queue-owning-library', 'independent-submission')).toThrow(
      'Independent native queue submission requires an isolated WebGPU device and surface.'
    );
  });

  test('imports borrowed and adopted buffers and textures with distinct ownership', async () => {
    const { interop } = await createDevice();
    const scope = interop.createScope('asset-import');
    const borrowedBufferNative = new NativeBuffer(64, 8);
    const adoptedBufferNative = new NativeBuffer(128, 8);
    const borrowedTextureNative = new NativeTexture(8, 4, 1, 'rgba8unorm', 16);
    const adoptedTextureNative = new NativeTexture(16, 8, 1, 'rgba8unorm', 16);

    const borrowedBuffer = scope.importBorrowed('buffer', borrowedBufferNative, {
      size: 64,
      usage: 8
    });
    const adoptedBuffer = scope.adopt('buffer', adoptedBufferNative, { size: 128, usage: 8 });
    const borrowedTexture = scope.importBorrowed('texture', borrowedTextureNative, {
      size: [8, 4],
      format: 'rgba8unorm',
      usage: 16
    });
    const adoptedTexture = scope.adopt('texture', adoptedTextureNative, {
      size: [16, 8],
      format: 'rgba8unorm',
      usage: 16
    });

    expect(scope.unwrapResource('buffer', borrowedBuffer)).toBe(borrowedBufferNative);
    expect(scope.unwrapResource('buffer', adoptedBuffer)).toBe(adoptedBufferNative);
    expect(scope.unwrapResource('texture', borrowedTexture)).toBe(borrowedTextureNative);
    expect(scope.unwrapResource('texture', adoptedTexture)).toBe(adoptedTextureNative);

    borrowedBuffer.dispose();
    adoptedBuffer.dispose();
    borrowedTexture.dispose();
    adoptedTexture.dispose();
    expect(borrowedBufferNative.destroyed).toBe(0);
    expect(borrowedTextureNative.destroyed).toBe(0);
    expect(adoptedBufferNative.destroyed).toBe(1);
    expect(adoptedTextureNative.destroyed).toBe(1);
  });

  test('validates import descriptors and rejects duplicate native ownership', async () => {
    const { interop } = await createDevice();
    const first = interop.createScope('first-owner');
    const second = interop.createScope('second-owner');
    const native = new NativeBuffer(64, 8);

    expect(() => first.importBorrowed('buffer', native, { size: 32, usage: 8 })).toThrow(
      'Native buffer size 64 does not match descriptor size 32.'
    );
    expect(() => first.importBorrowed('buffer', native, { size: 64, usage: 4 })).toThrow(
      'Native buffer usage 8 does not match descriptor usage 4.'
    );
    expect(() =>
      first.importBorrowed('buffer', native, {
        size: 64,
        usage: 8,
        mappedAtCreation: true
      })
    ).toThrow('Imported buffer descriptor cannot set mappedAtCreation.');

    const multisampled = new NativeTexture(8, 8, 1, 'rgba8unorm', 16, '2d', 1, 4);
    expect(() =>
      first.importBorrowed('texture', multisampled, {
        size: [8, 8],
        format: 'rgba8unorm',
        usage: 16
      })
    ).toThrow('Native texture sample count 4 does not match descriptor sample count 1.');

    first.importBorrowed('buffer', native, { size: 64, usage: 8 });
    expect(() => second.adopt('buffer', native, { size: 64, usage: 8 })).toThrow(
      'Native resource is already owned by interop scope "first-owner".'
    );
  });

  test('binds imported resources to their scope and cleans them up on dispose', async () => {
    const { device, interop } = await createDevice();
    const first = interop.createScope('first-owner');
    const second = interop.createScope('second-owner');
    const borrowedNative = new NativeBuffer(64, 8);
    const adoptedNative = new NativeBuffer(64, 8);
    const borrowed = first.importBorrowed('buffer', borrowedNative, { size: 64, usage: 8 });
    const adopted = first.adopt('buffer', adoptedNative, { size: 64, usage: 8 });
    const regular = device.createBuffer({ size: 16, usage: 8 });

    expect(() => second.unwrapResource('buffer', borrowed)).toThrow(
      'Resource belongs to interop scope "first-owner".'
    );
    expect(second.unwrapResource('buffer', regular)).toBeDefined();

    first.dispose();
    expect(borrowed.state).toBe('disposed');
    expect(adopted.state).toBe('disposed');
    expect(borrowedNative.destroyed).toBe(0);
    expect(adoptedNative.destroyed).toBe(1);
    expect(() => first.unwrapResource('buffer', regular)).toThrow(
      'Interop scope "first-owner" has been disposed.'
    );
  });

  test('retains native identity claims until pending submission leases are terminal', async () => {
    const { device, native, interop } = await createDevice();
    const first = interop.createScope('first-owner');
    const second = interop.createScope('second-owner');
    const importedNative = new NativeBuffer(64, 8);
    const imported = first.importBorrowed('buffer', importedNative, { size: 64, usage: 8 });
    const destination = device.createBuffer({ size: 64, usage: 8 });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(imported, 0, destination, 0, 64);
    const submission = device.queue.submit([encoder.finish()]);

    first.dispose();

    expect(() => second.importBorrowed('buffer', importedNative, { size: 64, usage: 8 })).toThrow(
      'Native resource is already owned by interop scope "first-owner".'
    );
    native.queue.complete(0);
    await submission.done;
    expect(() =>
      second.importBorrowed('buffer', importedNative, { size: 64, usage: 8 })
    ).not.toThrow();
  });

  test('invalidates scopes and imported handles when the device generation is lost', async () => {
    const { native, interop } = await createDevice();
    const scope = interop.createScope('loss-owner');
    const imported = scope.importBorrowed('buffer', new NativeBuffer(64, 8), {
      size: 64,
      usage: 8
    });

    native.lose({ reason: 'context-lost', message: 'GPU reset' });
    await native.lost;
    await Promise.resolve();

    expect(imported.state).toBe('device-lost');
    expect(() => scope.unwrapResource('buffer', imported)).toThrow(
      'Interop scope "loss-owner" belongs to a lost WebGPUDevice.'
    );
    expect(() => interop.createScope('late-owner')).toThrow('WebGPU interop device is lost.');
  });

  test('unwraps only the current open Aether-owned command encoder', async () => {
    const first = await createDevice();
    const second = await createDevice();
    const scope = first.interop.createScope('native-recorder');
    const encoder = first.device.createCommandEncoder();
    const foreign = second.device.createCommandEncoder();

    expect(scope.unwrapEncoder(encoder)).toBe(first.native.encoders[0]);
    expect(() => scope.unwrapEncoder(foreign)).toThrow('belongs to a different WebGPUDevice.');
    encoder.finish();
    expect(() => scope.unwrapEncoder(encoder)).toThrow(
      'WebGPU command encoder has already finished.'
    );
  });
});

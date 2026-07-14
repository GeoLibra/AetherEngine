import { describe, expect, test } from 'vitest';
import {
  WebGPUAdapter,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeComputePassPort,
  type WebGPUNativeDeviceLostInfo,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeRenderPassPort,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort
} from '../src';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class NativeResource implements WebGPUNativeResourcePort {
  destroyed = 0;
  destroy(): void { this.destroyed += 1; }
}

class NativeTexture extends NativeResource implements WebGPUNativeTexturePort {
  createView(): WebGPUNativeResourcePort { return new NativeResource(); }
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
  readonly commandBuffer = new NativeResource();
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  beginRenderPass(): WebGPUNativeRenderPassPort { return new EmptyRenderPass(); }
  beginComputePass(): WebGPUNativeComputePassPort { return new EmptyComputePass(); }
  copyBufferToBuffer(): void {}
  copyTextureToTexture(): void {}
  finish(): WebGPUNativeResourcePort { return this.commandBuffer; }
}

class NativeQueue {
  readonly submissions: WebGPUNativeResourcePort[][] = [];
  private readonly completions: Deferred<void>[] = [];

  submit(commandBuffers: readonly WebGPUNativeResourcePort[]): void {
    this.submissions.push([...commandBuffers]);
  }

  onSubmittedWorkDone(): Promise<void> {
    const completion = deferred<void>();
    this.completions.push(completion);
    return completion.promise;
  }

  complete(index: number): void { this.completion(index).resolve(undefined); }
  fail(index: number, error: unknown): void { this.completion(index).reject(error); }

  private completion(index: number): Deferred<void> {
    const completion = this.completions[index];
    if (completion === undefined) throw new Error(`Missing native completion ${index}.`);
    return completion;
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly queue = new NativeQueue();
  readonly buffers: NativeResource[] = [];
  readonly textures: NativeTexture[] = [];
  readonly encoders: NativeEncoder[] = [];
  private readonly loss = deferred<WebGPUNativeDeviceLostInfo>();
  readonly lost = this.loss.promise;

  createBuffer(): WebGPUNativeResourcePort {
    const buffer = new NativeResource();
    this.buffers.push(buffer);
    return buffer;
  }
  createTexture(): WebGPUNativeTexturePort {
    const texture = new NativeTexture();
    this.textures.push(texture);
    return texture;
  }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    const encoder = new NativeEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
  lose(info: WebGPUNativeDeviceLostInfo): void { this.loss.resolve(info); }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Submission Adapter' };
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

function recordCopy(device: Awaited<ReturnType<typeof createDevice>>['device']) {
  const source = device.createBuffer({ size: 16, usage: 1 });
  const destination = device.createBuffer({ size: 16, usage: 1 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
  return { source, destination, commands: encoder.finish() };
}

describe('WebGPU submission epochs', () => {
  test('submits native command buffers once, in order, and completes the epoch', async () => {
    const { device, native } = await createDevice();
    const first = recordCopy(device);
    const second = recordCopy(device);

    const submission = device.queue.submit([first.commands, second.commands]);

    expect(native.queue.submissions).toEqual([[
      native.encoders[0]?.commandBuffer,
      native.encoders[1]?.commandBuffer
    ]]);
    expect(device.fastPathMetrics().nativeQueueSubmits).toBe(1);
    expect(submission.status).toBe('pending');
    expect(device.queue.metrics()).toEqual({
      submitted: 1,
      pending: 1,
      completed: 0,
      failed: 0,
      deviceLost: 0,
      leasedResources: 6
    });

    native.queue.complete(0);
    await expect(submission.done).resolves.toEqual({ status: 'completed' });
    expect(device.queue.metrics()).toEqual({
      submitted: 1,
      pending: 0,
      completed: 1,
      failed: 0,
      deviceLost: 0,
      leasedResources: 0
    });
  });

  test('rejects duplicate and already-submitted command buffers before native submit', async () => {
    const { device, native } = await createDevice();
    const { commands } = recordCopy(device);

    expect(() => device.queue.submit([commands, commands])).toThrow('has already been submitted');
    expect(native.queue.submissions).toHaveLength(0);

    const submission = device.queue.submit([commands]);
    expect(() => device.queue.submit([commands])).toThrow('has already been submitted');
    expect(native.queue.submissions).toHaveLength(1);
    native.queue.complete(0);
    await submission.done;
  });

  test('settles rejected native completion as failed', async () => {
    const { device, native } = await createDevice();
    const submission = device.queue.submit([recordCopy(device).commands]);
    const error = new Error('native completion failed');

    native.queue.fail(0, error);

    await expect(submission.done).resolves.toEqual({ status: 'failed', error });
    expect(device.queue.metrics().failed).toBe(1);
  });

  test('settles every pending epoch as device-lost and ignores late completion', async () => {
    const { device, native } = await createDevice();
    const first = device.queue.submit([recordCopy(device).commands]);
    const second = device.queue.submit([recordCopy(device).commands]);

    native.lose({ reason: 'out-of-memory', message: 'GPU reset' });
    await device.lost;

    await expect(first.done).resolves.toEqual({ status: 'device-lost' });
    await expect(second.done).resolves.toEqual({ status: 'device-lost' });
    expect(device.queue.metrics()).toMatchObject({ pending: 0, deviceLost: 2, leasedResources: 0 });

    native.queue.complete(0);
    native.queue.complete(1);
    await Promise.resolve();
    expect(device.queue.metrics()).toMatchObject({ completed: 0, deviceLost: 2 });
  });

  test('defers native buffer and texture destruction until their submission is terminal', async () => {
    const { device, native } = await createDevice();
    const { source, destination, commands } = recordCopy(device);
    const sourceTexture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 1 });
    const destinationTexture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 1 });
    const textureEncoder = device.createCommandEncoder();
    textureEncoder.copyTextureToTexture(
      { texture: sourceTexture },
      { texture: destinationTexture },
      [4, 4]
    );
    const textureCommands = textureEncoder.finish();
    const submission = device.queue.submit([commands, textureCommands]);

    source.dispose();
    destination.dispose();
    sourceTexture.dispose();
    destinationTexture.dispose();
    commands.dispose();
    textureCommands.dispose();
    expect(native.buffers.map((buffer) => buffer.destroyed)).toEqual([0, 0]);
    expect(native.textures.map((texture) => texture.destroyed)).toEqual([0, 0]);
    expect(native.encoders[0]?.commandBuffer.destroyed).toBe(0);

    native.queue.complete(0);
    await submission.done;
    expect(native.buffers.map((buffer) => buffer.destroyed)).toEqual([1, 1]);
    expect(native.textures.map((texture) => texture.destroyed)).toEqual([1, 1]);
    expect(native.encoders[0]?.commandBuffer.destroyed).toBe(0);
  });
});

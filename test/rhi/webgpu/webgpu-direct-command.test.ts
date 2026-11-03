import { describe, expect, test } from 'vitest';
import {
  WebGPUAdapter,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeComputePassPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeRenderPassPort,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort
} from '../../../src';

class Handle implements WebGPUNativeResourcePort {}
class TextureHandle extends Handle implements WebGPUNativeTexturePort {
  createView(): WebGPUNativeResourcePort {
    return new Handle();
  }
}

class RenderPass implements WebGPUNativeRenderPassPort {
  constructor(private readonly calls: string[]) {}
  pushDebugGroup(): void {
    this.calls.push('render.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('render.popDebugGroup');
  }
  setPipeline(): void {
    this.calls.push('render.setPipeline');
  }
  setBindGroup(): void {
    this.calls.push('render.setBindGroup');
  }
  setVertexBuffer(): void {
    this.calls.push('render.setVertexBuffer');
  }
  setIndexBuffer(): void {
    this.calls.push('render.setIndexBuffer');
  }
  setViewport(): void {
    this.calls.push('render.setViewport');
  }
  setScissorRect(): void {
    this.calls.push('render.setScissorRect');
  }
  draw(): void {
    this.calls.push('render.draw');
  }
  drawIndexed(): void {
    this.calls.push('render.drawIndexed');
  }
  drawIndirect(): void {
    this.calls.push('render.drawIndirect');
  }
  end(): void {
    this.calls.push('render.end');
  }
}

class ComputePass implements WebGPUNativeComputePassPort {
  constructor(private readonly calls: string[]) {}
  pushDebugGroup(): void {
    this.calls.push('compute.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('compute.popDebugGroup');
  }
  setPipeline(): void {
    this.calls.push('compute.setPipeline');
  }
  setBindGroup(): void {
    this.calls.push('compute.setBindGroup');
  }
  dispatchWorkgroups(): void {
    this.calls.push('compute.dispatchWorkgroups');
  }
  dispatchWorkgroupsIndirect(): void {
    this.calls.push('compute.dispatchWorkgroupsIndirect');
  }
  end(): void {
    this.calls.push('compute.end');
  }
}

class NativeEncoder implements WebGPUNativeCommandEncoderPort {
  readonly calls: string[] = [];
  readonly renderPassDescriptors: Readonly<Record<string, unknown>>[] = [];
  pushDebugGroup(): void {
    this.calls.push('encoder.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('encoder.popDebugGroup');
  }
  beginRenderPass(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeRenderPassPort {
    this.calls.push('encoder.beginRenderPass');
    this.renderPassDescriptors.push(descriptor);
    return new RenderPass(this.calls);
  }
  beginComputePass(): WebGPUNativeComputePassPort {
    this.calls.push('encoder.beginComputePass');
    return new ComputePass(this.calls);
  }
  copyBufferToBuffer(): void {
    this.calls.push('encoder.copyBufferToBuffer');
  }
  copyTextureToTexture(): void {
    this.calls.push('encoder.copyTextureToTexture');
  }
  copyBufferToTexture(): void {
    this.calls.push('encoder.copyBufferToTexture');
  }
  copyTextureToBuffer(): void {
    this.calls.push('encoder.copyTextureToBuffer');
  }
  finish(): WebGPUNativeResourcePort {
    this.calls.push('encoder.finish');
    return new Handle();
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly lost = new Promise<never>(() => undefined);
  readonly queue = { submit(): void {}, onSubmittedWorkDone: async () => undefined };
  readonly encoders: NativeEncoder[] = [];
  createBuffer(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createTexture(): WebGPUNativeTexturePort {
    return new TextureHandle();
  }
  createShaderModule(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createRenderPipeline(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createComputePipeline(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    const encoder = new NativeEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Direct Adapter' };
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
  return { device, native: adapter.device };
}

describe('WebGPU direct command recording', () => {
  test('rejects cross-format texture copies before native encoder forwarding', async () => {
    const { device, native } = await createDevice();
    const source = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 1 });
    const destination = device.createTexture({ size: [1, 1], format: 'r8unorm', usage: 2 });
    const encoder = device.createCommandEncoder();

    expect(() =>
      encoder.copyTextureToTexture({ texture: source }, { texture: destination }, [1, 1])
    ).toThrow(/require identical formats/i);
    expect(native.encoders[0]?.calls).toEqual([]);
  });

  test('forwards copy commands immediately through exactly one native encoder', async () => {
    const { device, native } = await createDevice();
    const source = device.createBuffer({ size: 16, usage: 1 });
    const destination = device.createBuffer({ size: 16, usage: 1 });
    const encoder = device.createCommandEncoder({ label: 'direct' });

    encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
    expect(native.encoders).toHaveLength(1);
    expect(native.encoders[0]?.calls).toEqual(['encoder.copyBufferToBuffer']);

    const commands = encoder.finish({ label: 'commands' });
    expect(native.encoders[0]?.calls).toEqual(['encoder.copyBufferToBuffer', 'encoder.finish']);
    expect(commands.getCommandStream()).toEqual([]);
    expect(device.fastPathMetrics()).toMatchObject({
      nativeEncoders: 1,
      nativeCommandBuffers: 1,
      commandWrapperAllocations: 2,
      commandReplayRecordAllocations: 0
    });
  });

  test('forwards render pass operations without a replay command stream', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    const pipeline = device.createRenderPipeline({ vertex: { module: shader } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }]
    });

    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();

    expect(native.encoders[0]?.calls).toEqual([
      'encoder.beginRenderPass',
      'render.setPipeline',
      'render.draw',
      'render.end'
    ]);
  });

  test('snapshots mutable clear colors before native render-pass lowering', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
    const clearValue: [number, number, number, number] = [0, 0, 0, 1];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue
        }
      ]
    });

    clearValue[0] = 1;
    pass.end();

    expect(native.encoders[0]?.renderPassDescriptors[0]).toMatchObject({
      colorAttachments: [{ clearValue: [0, 0, 0, 1] }]
    });
  });

  test('rejects invalid pass and encoder state before native forwarding', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }]
    });

    expect(() => pass.draw(3)).toThrow('WebGPU render pass requires a pipeline before drawing.');
    expect(native.encoders[0]?.calls).toEqual(['encoder.beginRenderPass']);
    pass.end();
    expect(() => pass.draw(3)).toThrow('WebGPU render pass has already ended.');
    encoder.finish();
    expect(() => encoder.pushDebugGroup('late')).toThrow(
      'WebGPU command encoder has already finished.'
    );
  });

  test('validates buffer and texture copy bounds before native forwarding', async () => {
    const { device, native } = await createDevice();
    const source = device.createBuffer({ label: 'source', size: 16, usage: 1 });
    const destination = device.createBuffer({ label: 'destination', size: 16, usage: 1 });
    const texture = device.createTexture({
      label: 'texture',
      size: [8, 8],
      mipLevelCount: 2,
      format: 'rgba8unorm',
      usage: 1
    });
    const encoder = device.createCommandEncoder();

    expect(() => encoder.copyBufferToBuffer(source, 12, destination, 0, 8)).toThrow(
      'Buffer range 12..20 is outside buffer size 16.'
    );
    expect(() =>
      encoder.copyTextureToTexture({ texture, mipLevel: 1 }, { texture, mipLevel: 1 }, [8, 8])
    ).toThrow('Texture copy range exceeds texture "texture" mip level 1 bounds 4x4x1.');
    expect(native.encoders[0]?.calls).toEqual([]);
  });

  test('lowers buffer-texture copies directly to the native encoder', async () => {
    const { device, native } = await createDevice();
    const upload = device.createBuffer({ size: 1024, usage: 1 << 2 });
    const readback = device.createBuffer({ size: 1024, usage: 1 << 3 });
    const texture = device.createTexture({
      size: [4, 2],
      format: 'rgba8unorm',
      usage: (1 << 0) | (1 << 1)
    });
    const encoder = device.createCommandEncoder();

    encoder.copyBufferToTexture({ buffer: upload, bytesPerRow: 256 }, { texture }, [4, 2]);
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [4, 2]);

    expect(native.encoders[0]?.calls).toEqual([
      'encoder.copyBufferToTexture',
      'encoder.copyTextureToBuffer'
    ]);
  });

  test('requires a compute pipeline and then forwards dispatch directly', async () => {
    const { device, native } = await createDevice();
    const firstEncoder = device.createCommandEncoder();
    const missingPipeline = firstEncoder.beginComputePass();
    expect(() => missingPipeline.dispatchWorkgroups(2)).toThrow(
      'WebGPU compute pass requires a pipeline before dispatch.'
    );
    expect(native.encoders[0]?.calls).toEqual(['encoder.beginComputePass']);
    missingPipeline.end();

    const shader = device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
    const pipeline = device.createComputePipeline({ compute: { module: shader } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(2, 3, 4);
    pass.end();
    expect(native.encoders[1]?.calls).toEqual([
      'encoder.beginComputePass',
      'compute.setPipeline',
      'compute.dispatchWorkgroups',
      'compute.end'
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import {
  WebGPUAdapter,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort
} from '../../../src';

class NativeResource implements WebGPUNativeResourcePort {
  destroyed = 0;
  mapRequests = 0;
  mappedRangeRequests = 0;
  unmaps = 0;
  mapResult: Promise<void> = Promise.resolve();
  destroy(): void { this.destroyed += 1; }
  mapAsync(): Promise<void> { this.mapRequests += 1; return this.mapResult; }
  getMappedRange(_offset: number, size: number): ArrayBuffer {
    this.mappedRangeRequests += 1;
    return new ArrayBuffer(size);
  }
  unmap(): void { this.unmaps += 1; }
}

class NativeTexture extends NativeResource implements WebGPUNativeTexturePort {
  readonly views: Readonly<Record<string, unknown>>[] = [];
  createView(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.views.push(descriptor);
    return new NativeResource();
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly lost = new Promise<never>(() => undefined);
  readonly queue = { submit(): void {}, onSubmittedWorkDone: async () => undefined };
  readonly calls: { operation: string; descriptor: Readonly<Record<string, unknown>> }[] = [];
  readonly resources: NativeResource[] = [];

  createBuffer(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'buffer', descriptor });
    const resource = new NativeResource();
    this.resources.push(resource);
    return resource;
  }
  createTexture(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeTexturePort {
    this.calls.push({ operation: 'texture', descriptor });
    return new NativeTexture();
  }
  createSampler(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'sampler', descriptor });
    return new NativeResource();
  }
  createShaderModule(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'shader', descriptor });
    return new NativeResource();
  }
  createBindGroupLayout(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'bind-group-layout', descriptor });
    return new NativeResource();
  }
  createPipelineLayout(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'pipeline-layout', descriptor });
    return new NativeResource();
  }
  createBindGroup(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'bind-group', descriptor });
    return new NativeResource();
  }
  createRenderPipeline(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'render-pipeline', descriptor });
    return new NativeResource();
  }
  createComputePipeline(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    this.calls.push({ operation: 'compute-pipeline', descriptor });
    return new NativeResource();
  }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Resource Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly devices: NativeDevice[] = [];
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    const device = new NativeDevice();
    this.devices.push(device);
    return device;
  }
}

async function createDevice(adapter = new NativeAdapter()) {
  const device = await new WebGPUAdapter(adapter).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  const native = adapter.devices[0];
  if (native === undefined) throw new Error('Expected native device.');
  return { device, native };
}

describe('WebGPU resource lowering', () => {
  test('lowers value descriptors once and snapshots portable state', async () => {
    const { device, native } = await createDevice();
    const size = { width: 8, height: 4 };
    const buffer = device.createBuffer({ label: 'vertices', size: 64, usage: 1 });
    const texture = device.createTexture({
      label: 'color',
      size,
      mipLevelCount: 4,
      format: 'rgba8unorm',
      usage: 16
    });
    size.width = 99;
    const view = texture.createView({ label: 'color-view' });
    const mipView = texture.createView({ baseMipLevel: 2 });
    device.createSampler({ label: 'linear', magFilter: 'linear' });
    device.createShaderModule({ label: 'shader', code: '@vertex fn main() {}' });

    expect(native.calls.map((call) => call.operation)).toEqual(['buffer', 'texture', 'sampler', 'shader']);
    expect(native.calls[1]?.descriptor.size).toEqual({ width: 8, height: 4, depthOrArrayLayers: 1 });
    expect(Object.isFrozen(native.calls[1]?.descriptor)).toBe(true);
    expect(texture.width).toBe(8);
    expect(view.texture).toBe(texture);
    expect([mipView.width, mipView.height]).toEqual([2, 1]);
    expect(buffer).not.toHaveProperty('native');
    expect(buffer).not.toHaveProperty('nativeHandle');
  });

  test('lowers RHI handle-bearing binding and pipeline descriptors', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ size: 64, usage: 1 });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: {} }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] });
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    const primitive: { topology: 'triangle-list' | 'line-list' } = { topology: 'triangle-list' };
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: 'main' },
      primitive
    });
    primitive.topology = 'line-list';

    expect(native.calls.map((call) => call.operation)).toEqual([
      'buffer', 'bind-group-layout', 'pipeline-layout', 'bind-group', 'shader', 'render-pipeline'
    ]);
    expect(native.calls[3]?.descriptor.entries).not.toEqual([{ binding: 0, resource: { buffer } }]);
    expect(pipeline.topology).toBe('triangle-list');
    expect(pipeline.descriptor.primitive?.topology).toBe('triangle-list');
  });

  test('rejects foreign handles before invoking native creation', async () => {
    const first = await createDevice();
    const second = await createDevice();
    const foreignLayout = first.device.createBindGroupLayout({ entries: [] });
    const callCount = second.native.calls.length;

    expect(() => second.device.createPipelineLayout({ bindGroupLayouts: [foreignLayout] })).toThrow(
      'belongs to a different WebGPUDevice.'
    );
    expect(second.native.calls).toHaveLength(callCount);
  });

  test('enforces the unmapped to mapping-pending to mapped state machine', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ label: 'mapped', size: 64, usage: 1 });
    const nativeBuffer = native.resources[0]!;
    let resolveMap!: () => void;
    nativeBuffer.mapResult = new Promise<void>((resolve) => { resolveMap = resolve; });

    expect(() => buffer.getMappedRange()).toThrow('is not mapped');
    const mapping = buffer.mapAsync(1, 4, 8);
    await expect(buffer.mapAsync(1, 4, 8)).rejects.toThrow('mapping is already pending');
    expect(() => buffer.getMappedRange(4, 8)).toThrow('is not mapped');
    expect(nativeBuffer.mapRequests).toBe(1);

    resolveMap();
    await mapping;
    expect(buffer.getMappedRange(4, 8).byteLength).toBe(8);
    expect(nativeBuffer.mappedRangeRequests).toBe(1);

    buffer.unmap();
    expect(nativeBuffer.unmaps).toBe(1);
    expect(() => buffer.getMappedRange()).toThrow('is not mapped');
    await expect(buffer.mapAsync(1, 60, 8)).rejects.toThrow('outside buffer size 64');
    expect(nativeBuffer.mapRequests).toBe(1);
  });
});

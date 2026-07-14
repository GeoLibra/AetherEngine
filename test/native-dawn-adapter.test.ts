import { describe, expect, test } from 'vitest';

import {
  NativeDawnAdapter,
  RHIDeviceRequestError,
  type NativeDawnAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeDeviceLostInfo,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeResourcePort
} from '../src';

class Handle implements WebGPUNativeResourcePort {}

class Encoder implements WebGPUNativeCommandEncoderPort {
  readonly calls: string[] = [];
  pushDebugGroup(): void { this.calls.push('push'); }
  popDebugGroup(): void { this.calls.push('pop'); }
  beginRenderPass(): never { throw new Error('unused'); }
  beginComputePass(): never { throw new Error('unused'); }
  copyBufferToBuffer(): void { this.calls.push('copy'); }
  copyTextureToTexture(): void { this.calls.push('copy-texture'); }
  finish(): WebGPUNativeResourcePort { this.calls.push('finish'); return new Handle(); }
}

class DevicePort implements WebGPUNativeDevicePort {
  private resolveLost!: (info: WebGPUNativeDeviceLostInfo) => void;
  readonly lost = new Promise<WebGPUNativeDeviceLostInfo>((resolve) => { this.resolveLost = resolve; });
  readonly encoders: Encoder[] = [];
  submits = 0;
  readonly queue = {
    submit: () => { this.submits += 1; },
    onSubmittedWorkDone: async () => undefined
  };
  createBuffer(): WebGPUNativeResourcePort { return new Handle(); }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    const encoder = new Encoder();
    this.encoders.push(encoder);
    return encoder;
  }
  lose(info: WebGPUNativeDeviceLostInfo): void { this.resolveLost(info); }
}

class DawnPort implements NativeDawnAdapterPort {
  readonly info = { name: 'Test Dawn', vendor: 'Aether', architecture: 'fake' };
  readonly dawn = { version: '1.2.3', backend: 'metal' as const };
  readonly features = new Set<string>(['timestamp-query']);
  readonly limits = { maxBufferSize: 8192 };
  readonly formats = new Map();
  readonly requests: WebGPUNativeDeviceRequest[] = [];
  readonly devices: DevicePort[] = [];
  bridgeCalls = 0;

  async requestDevice(request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    this.requests.push(request);
    const device = new DevicePort();
    this.devices.push(device);
    return device;
  }
}

describe('NativeDawnAdapter', () => {
  test('publishes immutable Dawn facts and negotiates required/optional capabilities', async () => {
    const port = new DawnPort();
    const adapter = new NativeDawnAdapter(port);
    const device = await adapter.requestDevice({
      requiredFeatures: ['compute'], optionalFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 4096 }, label: 'native-main'
    });

    expect(adapter.info).toEqual({
      name: 'Test Dawn', backend: 'native', vendor: 'Aether', architecture: 'fake'
    });
    expect(adapter.facts).toEqual({ dawnVersion: '1.2.3', nativeBackend: 'metal' });
    expect(Object.isFrozen(adapter.facts)).toBe(true);
    expect(adapter.capabilities.backend).toBe('native');
    expect(device.capabilities.backend).toBe('native');
    expect(port.requests).toEqual([{
      label: 'native-main', requiredFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 4096 }
    }]);
  });

  test('reports missing Dawn capabilities before native device creation', async () => {
    const port = new DawnPort();
    port.features.delete('timestamp-query');
    const adapter = new NativeDawnAdapter(port);
    const result = adapter.requestDevice({
      requiredFeatures: ['timestamp-query'], optionalFeatures: [],
      requiredLimits: { maxBufferSize: 9000 }
    });

    await expect(result).rejects.toBeInstanceOf(RHIDeviceRequestError);
    await expect(result).rejects.toMatchObject({ missing: [
      { kind: 'feature', feature: 'timestamp-query' },
      { kind: 'limit', limit: 'maxBufferSize', minimum: 9000, actual: 8192 }
    ] });
    expect(port.requests).toEqual([]);
  });

  test('records and submits directly, preserves loss generation, and never uses the bridge', async () => {
    const port = new DawnPort();
    const adapter = new NativeDawnAdapter(port);
    const first = await adapter.requestDevice({ requiredFeatures: [], optionalFeatures: [] });
    const second = await adapter.requestDevice({ requiredFeatures: [], optionalFeatures: [] });
    const source = first.createBuffer({ size: 16, usage: 1 });
    const destination = first.createBuffer({ size: 16, usage: 1 });
    const encoder = first.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
    const commands = encoder.finish();
    first.queue.submit([commands]);

    expect(port.devices[0]!.encoders[0]!.calls).toEqual(['copy', 'finish']);
    expect(port.devices[0]!.submits).toBe(1);
    expect(port.bridgeCalls).toBe(0);
    expect(second.generation).toBeGreaterThan(first.generation);
    port.devices[0]!.lose({ reason: 'context-lost', message: 'simulated' });
    await expect(first.lost).resolves.toMatchObject({
      reason: 'context-lost', message: 'simulated', generation: first.generation
    });
    expect(first.state).toBe('lost');
  });
});

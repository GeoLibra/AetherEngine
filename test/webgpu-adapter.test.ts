import { describe, expect, test } from 'vitest';
import {
  RHIDeviceRequestError,
  WebGPUAdapter,
  WebGPUNativeDeviceRequestError,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest
} from '../src';

class TestNativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = Object.freeze({
    name: 'Test WebGPU',
    vendor: 'Aether Labs',
    architecture: 'fake-gpu'
  });
  readonly features = new Set<string>(['timestamp-query']);
  readonly limits = Object.freeze({ maxBufferSize: 8192, maxBindGroups: 4 });
  readonly formats = new Map([
    ['bgra8unorm', Object.freeze({
      sample: true,
      filter: true,
      render: true,
      blend: true,
      storage: false,
      copySrc: true,
      copyDst: true,
      sampleCounts: Object.freeze([1, 4])
    })]
  ]);
  readonly requests: WebGPUNativeDeviceRequest[] = [];
  failure: unknown;

  async requestDevice(request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    this.requests.push(request);
    if (this.failure !== undefined) throw this.failure;
    return {
      lost: new Promise(() => undefined),
      queue: { submit(): void {}, onSubmittedWorkDone: async () => undefined }
    };
  }
}

describe('WebGPUAdapter', () => {
  test('publishes immutable WebGPU facts and requests selected native features once', async () => {
    const native = new TestNativeAdapter();
    const adapter = new WebGPUAdapter(native);

    const device = await adapter.requestDevice({
      requiredFeatures: ['compute'],
      optionalFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 4096 },
      label: 'main-webgpu'
    });

    expect(adapter.info).toEqual({
      name: 'Test WebGPU',
      backend: 'webgpu',
      vendor: 'Aether Labs',
      architecture: 'fake-gpu'
    });
    expect(adapter.capabilities.features.get('compute')).toEqual({ status: 'native' });
    expect(adapter.capabilities.features.get('timestamp-query')).toEqual({ status: 'native' });
    expect(adapter.capabilities.queues.map((queue) => queue.role)).toEqual(['graphics', 'compute', 'transfer']);
    expect(Object.isFrozen(adapter.capabilities)).toBe(true);
    expect('set' in adapter.capabilities.features).toBe(false);
    expect(native.requests).toEqual([{
      label: 'main-webgpu',
      requiredFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 4096 }
    }]);
    expect(Object.isFrozen(native.requests[0])).toBe(true);
    expect(device.capabilities.features.get('timestamp-query')).toEqual({ status: 'native' });
  });

  test('rejects unsupported requirements before calling the native adapter', async () => {
    const native = new TestNativeAdapter();
    native.features.delete('timestamp-query');
    const adapter = new WebGPUAdapter(native);

    const result = adapter.requestDevice({
      requiredFeatures: ['timestamp-query'],
      optionalFeatures: [],
      requiredLimits: { maxBufferSize: 16384 }
    });

    await expect(result).rejects.toMatchObject({
      code: 'rhi/device-request-failed',
      missing: [
        { kind: 'feature', feature: 'timestamp-query' },
        { kind: 'limit', limit: 'maxBufferSize', minimum: 16384, actual: 8192 }
      ]
    });
    await expect(result).rejects.toBeInstanceOf(RHIDeviceRequestError);
    expect(native.requests).toHaveLength(0);
  });

  test('preserves native request failure context', async () => {
    const native = new TestNativeAdapter();
    const cause = new Error('browser denied device');
    native.failure = cause;
    const adapter = new WebGPUAdapter(native);

    const result = adapter.requestDevice({
      requiredFeatures: [],
      optionalFeatures: [],
      label: 'denied-device'
    });

    await expect(result).rejects.toMatchObject({
      code: 'rhi/webgpu-device-request-failed',
      adapterName: 'Test WebGPU',
      deviceLabel: 'denied-device',
      cause
    });
    await expect(result).rejects.toBeInstanceOf(WebGPUNativeDeviceRequestError);
  });
});

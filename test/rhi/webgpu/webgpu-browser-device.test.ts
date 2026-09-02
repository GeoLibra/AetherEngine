import { describe, expect, test } from 'vitest';
import { WebGPUAdapter, requestBrowserWebGPUAdapter, type Diagnostic } from '../../../src';

interface ListenerEvent {
  readonly error: { readonly name: string; readonly message: string };
}

describe('browser WebGPU device port', () => {
  test('lowers one device request and resource descriptors to WebIDL calls', async () => {
    const calls: Array<{ readonly operation: string; readonly value: unknown }> = [];
    const nativeDevice = createNativeDevice(calls);
    const nativeAdapter = createNativeAdapter(nativeDevice, calls);
    const port = await requestBrowserWebGPUAdapter(createEnvironment(nativeAdapter), {});
    if (port === null) throw new Error('Expected adapter port.');

    const device = await new WebGPUAdapter(port).requestDevice({
      label: 'browser-device',
      requiredFeatures: [],
      optionalFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 4096 }
    });
    device.createBuffer({ label: 'vertices', size: 64, usage: 1 });
    device.createTexture({
      label: 'color',
      size: { width: 8, height: 4 },
      format: 'rgba8unorm',
      usage: 16
    });

    expect(calls.slice(0, 3)).toEqual([
      {
        operation: 'requestDevice',
        value: {
          label: 'browser-device',
          requiredFeatures: ['timestamp-query'],
          requiredLimits: { maxBufferSize: 4096 }
        }
      },
      { operation: 'createBuffer', value: { label: 'vertices', size: 64, usage: 1 } },
      {
        operation: 'createTexture',
        value: {
          label: 'color',
          size: { width: 8, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm',
          usage: 16
        }
      }
    ]);
  });

  test('forwards loss, error scopes, and uncaptured errors through the existing device', async () => {
    const calls: Array<{ readonly operation: string; readonly value: unknown }> = [];
    let resolveLost!: (value: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((resolve) => {
      resolveLost = resolve;
    });
    const listeners = new Set<(event: ListenerEvent) => void>();
    const nativeDevice = createNativeDevice(calls, lost, listeners);
    const nativeAdapter = createNativeAdapter(nativeDevice, calls);
    const port = await requestBrowserWebGPUAdapter(createEnvironment(nativeAdapter), {});
    if (port === null) throw new Error('Expected adapter port.');
    const adapter = new WebGPUAdapter(port);
    const device = await adapter.requestDevice({ requiredFeatures: [], optionalFeatures: [] });
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    await expect(
      device.createRenderPipelineAsync({ vertex: { module: shader } })
    ).resolves.toMatchObject({ status: 'success' });

    expect(calls).toEqual(
      expect.arrayContaining([
        { operation: 'pushErrorScope', value: 'validation' },
        { operation: 'popErrorScope', value: undefined }
      ])
    );

    listeners.forEach((listener) =>
      listener({
        error: { name: 'GPUValidationError', message: 'bad binding' }
      })
    );
    const diagnostics = device.diagnostics.list() as readonly Diagnostic[];
    expect(diagnostics[0]).toMatchObject({
      code: 'rhi/webgpu-uncaptured-validation',
      message: 'bad binding'
    });

    resolveLost({ reason: 'unknown', message: 'device reset' });
    await expect(device.lost).resolves.toMatchObject({
      reason: 'unknown',
      message: 'device reset'
    });
  });
});

function createEnvironment(adapter: object) {
  return {
    gpu: {
      async requestAdapter(): Promise<object> {
        return adapter;
      }
    },
    getCanvasContext(): null {
      return null;
    }
  };
}

function createNativeAdapter(
  device: object,
  calls: Array<{ readonly operation: string; readonly value: unknown }>
) {
  return {
    info: { vendor: 'Aether Labs', architecture: 'unit-gpu', description: 'Browser GPU' },
    features: new Set(['timestamp-query']),
    limits: { maxBufferSize: 8192, maxBindGroups: 4 },
    async requestDevice(descriptor: unknown): Promise<object> {
      calls.push({ operation: 'requestDevice', value: descriptor });
      return device;
    }
  };
}

function createNativeDevice(
  calls: Array<{ readonly operation: string; readonly value: unknown }>,
  lost: Promise<{ reason: string; message: string }> = new Promise(() => undefined),
  listeners: Set<(event: ListenerEvent) => void> = new Set()
) {
  return {
    lost,
    queue: {
      submit(): void {},
      async onSubmittedWorkDone(): Promise<void> {}
    },
    createBuffer(descriptor: unknown): object {
      calls.push({ operation: 'createBuffer', value: descriptor });
      return { size: 64, usage: 1, destroy(): void {} };
    },
    createTexture(descriptor: unknown): object {
      calls.push({ operation: 'createTexture', value: descriptor });
      return {
        createView(): object {
          return {};
        },
        destroy(): void {}
      };
    },
    createShaderModule(): object {
      return {};
    },
    async createRenderPipelineAsync(): Promise<object> {
      return {};
    },
    pushErrorScope(filter: unknown): void {
      calls.push({ operation: 'pushErrorScope', value: filter });
    },
    async popErrorScope(): Promise<null> {
      calls.push({ operation: 'popErrorScope', value: undefined });
      return null;
    },
    addEventListener(_type: 'uncapturederror', listener: (event: ListenerEvent) => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: 'uncapturederror', listener: (event: ListenerEvent) => void): void {
      listeners.delete(listener);
    }
  };
}

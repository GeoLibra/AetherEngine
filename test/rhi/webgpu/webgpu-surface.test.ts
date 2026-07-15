import { describe, expect, test } from 'vitest';
import * as AetherEngine from '../../../src';
import type {
  RHISurface,
  RHISurfaceConfiguration,
  SurfaceTarget,
  WebGPUNativeAdapterPort,
  WebGPUNativeDeviceLostInfo,
  WebGPUNativeDevicePort,
  WebGPUNativeDeviceRequest,
  WebGPUNativeResourcePort,
  WebGPUNativeTexturePort
} from '../../../src';

const CONFIGURATION: RHISurfaceConfiguration = Object.freeze({
  format: 'bgra8unorm',
  colorSpace: 'srgb',
  alphaMode: 'opaque',
  width: 640,
  height: 360,
  presentMode: 'fifo'
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class NativeTexture implements WebGPUNativeTexturePort {
  destroyed = 0;
  createView(): WebGPUNativeResourcePort { return {}; }
  destroy(): void { this.destroyed += 1; }
}

type NativeAcquireResult =
  | { readonly status: 'success'; readonly texture: NativeTexture }
  | { readonly status: 'outdated' | 'timeout' | 'lost' | 'out-of-memory' };

class NativeCanvasContext {
  readonly configurations: Readonly<Record<string, unknown>>[] = [];
  readonly acquisitions: NativeAcquireResult[] = [];
  acquireCalls = 0;
  presents = 0;
  unconfigures = 0;

  configure(descriptor: Readonly<Record<string, unknown>>): void {
    this.configurations.push(descriptor);
  }
  getCurrentTexture(): NativeAcquireResult {
    this.acquireCalls += 1;
    return this.acquisitions.shift() ?? { status: 'success', texture: new NativeTexture() };
  }
  present(): void { this.presents += 1; }
  unconfigure(): void { this.unconfigures += 1; }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly queue = { submit(): void {}, onSubmittedWorkDone: async () => undefined };
  private readonly loss = deferred<WebGPUNativeDeviceLostInfo>();
  readonly lost = this.loss.promise;
  lose(info: WebGPUNativeDeviceLostInfo): void { this.loss.resolve(info); }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Surface Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly device = new NativeDevice();
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> { return this.device; }
}

function createTarget(name: string): SurfaceTarget {
  return Object.freeze({ id: Symbol(name), kind: 'canvas' });
}

function createSurface(target: SurfaceTarget, context: NativeCanvasContext): RHISurface {
  const constructor = (AetherEngine as unknown as {
    WebGPUSurface: new (target: SurfaceTarget, context: NativeCanvasContext) => RHISurface;
  }).WebGPUSurface;
  return new constructor(target, context);
}

async function createDevice() {
  const adapter = new NativeAdapter();
  const device = await new AetherEngine.WebGPUAdapter(adapter).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native: adapter.device };
}

describe('WebGPUSurface', () => {
  test('configures the native context from an immutable snapshot and advances generation', async () => {
    const { device } = await createDevice();
    const context = new NativeCanvasContext();
    const surface = createSurface(createTarget('main'), context);
    const mutable = { ...CONFIGURATION };

    surface.configure(device, mutable, 4);
    mutable.width = 1;

    expect(surface.state).toBe('configured');
    expect(surface.generation).toBe(1);
    expect(surface.configuration).toEqual(CONFIGURATION);
    expect(Object.isFrozen(surface.configuration)).toBe(true);
    expect(context.configurations[0]).toMatchObject({
      format: 'bgra8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 640,
      height: 360,
      presentMode: 'fifo'
    });

    surface.configure(device, { ...CONFIGURATION, width: 800 }, 5);
    expect(surface.generation).toBe(2);
    expect(context.configurations).toHaveLength(2);
  });

  test('acquires one current texture and releases it on present or reconfigure', async () => {
    const { device } = await createDevice();
    const context = new NativeCanvasContext();
    const firstNativeTexture = new NativeTexture();
    context.acquisitions.push({ status: 'success', texture: firstNativeTexture });
    const surface = createSurface(createTarget('frame'), context);
    surface.configure(device, CONFIGURATION, 1);

    const acquired = surface.acquire();
    if (acquired.status !== 'success') throw new Error('Expected a frame.');
    expect(surface.acquire()).toEqual({ status: 'timeout' });
    expect(context.acquireCalls).toBe(1);
    expect(acquired.frame.generation).toBe(1);
    expect(acquired.frame.texture.descriptor).toMatchObject({
      size: { width: 640, height: 360, depthOrArrayLayers: 1 },
      format: 'bgra8unorm'
    });

    acquired.frame.present();
    expect(acquired.frame.state).toBe('presented');
    expect(acquired.frame.texture.state).toBe('disposed');
    expect(firstNativeTexture.destroyed).toBe(0);
    expect(context.presents).toBe(1);

    const second = surface.acquire();
    if (second.status !== 'success') throw new Error('Expected a second frame.');
    surface.configure(device, { ...CONFIGURATION, width: 800 }, 2);
    expect(second.frame.state).toBe('released');
    expect(second.frame.texture.state).toBe('disposed');
  });

  test('maps native acquire outcomes and zero extent without extra native acquisition', async () => {
    const { device } = await createDevice();
    const context = new NativeCanvasContext();
    context.acquisitions.push(
      { status: 'outdated' },
      { status: 'out-of-memory' },
      { status: 'lost' }
    );
    const surface = createSurface(createTarget('failure'), context);
    surface.configure(device, CONFIGURATION, 1);

    expect(surface.acquire()).toEqual({ status: 'outdated' });
    expect(surface.acquire()).toEqual({ status: 'out-of-memory' });
    expect(surface.acquire()).toEqual({ status: 'lost' });
    expect(surface.state).toBe('lost');

    surface.configure(device, { ...CONFIGURATION, width: 0 }, 2);
    expect(surface.acquire()).toEqual({ status: 'zero-extent' });
    expect(context.acquireCalls).toBe(3);
  });

  test('invalidates acquired textures on device loss and reports device-lost', async () => {
    const { device, native } = await createDevice();
    const context = new NativeCanvasContext();
    const surface = createSurface(createTarget('loss'), context);
    surface.configure(device, CONFIGURATION, 1);
    const acquired = surface.acquire();
    if (acquired.status !== 'success') throw new Error('Expected a frame.');

    native.lose({ reason: 'context-lost', message: 'GPU reset' });
    await device.lost;

    expect(acquired.frame.texture.state).toBe('device-lost');
    acquired.frame.release();
    expect(surface.acquire()).toEqual({ status: 'device-lost' });
  });

  test('unconfigures the native context and rejects use after dispose', async () => {
    const { device } = await createDevice();
    const context = new NativeCanvasContext();
    const surface = createSurface(createTarget('dispose'), context);
    surface.configure(device, CONFIGURATION, 1);

    surface.dispose();

    expect(surface.state).toBe('disposed');
    expect(context.unconfigures).toBe(1);
    expect(() => surface.acquire()).toThrow('WebGPUSurface has been disposed.');
    expect(() => surface.configure(device, CONFIGURATION, 2)).toThrow('WebGPUSurface has been disposed.');
  });
});

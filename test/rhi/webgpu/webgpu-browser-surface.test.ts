import { describe, expect, test } from 'vitest';
import { createBrowserGraphics } from '../../../src';

describe('browser WebGPU canvas surface', () => {
  test('configures once per identity, suspends at zero extent, and acquires a single frame', async () => {
    const configurations: unknown[] = [];
    let textureRequests = 0;
    const context = {
      configure(value: unknown): void { configurations.push(value); },
      getCurrentTexture(): object {
        textureRequests += 1;
        return {
          width: 32, height: 16, depthOrArrayLayers: 1, format: 'bgra8unorm', usage: 16,
          dimension: '2d', mipLevelCount: 1, sampleCount: 1,
          createView(): object { return {}; }
        };
      },
      unconfigure(): void {}
    };
    const device = {
      lost: new Promise(() => undefined),
      queue: { submit(): void {}, async onSubmittedWorkDone(): Promise<void> {} },
      addEventListener(): void {}, removeEventListener(): void {}
    };
    const adapter = {
      info: { description: 'Surface GPU' }, features: new Set<string>(), limits: {},
      async requestDevice(): Promise<object> { return device; }
    };
    const canvas = { getContext(): object { return context; } };
    const session = await createBrowserGraphics({
      canvas,
      environment: {
        gpu: { getPreferredCanvasFormat(): string { return 'bgra8unorm'; }, async requestAdapter(): Promise<object> { return adapter; } },
        getCanvasContext(): typeof context { return context; }
      },
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 32, height: 16 }
    });

    const first = session.surface.acquire();
    if (first.status !== 'success') throw new Error('Expected frame.');
    expect(session.surface.acquire()).toEqual({ status: 'timeout' });
    expect(textureRequests).toBe(1);
    first.frame.present();

    session.resize({ width: 0, height: 16 });
    expect(session.surface.acquire()).toEqual({ status: 'zero-extent' });
    expect(textureRequests).toBe(1);
    session.resize({ width: 32, height: 16 });
    expect(session.surface.generation).toBe(3);
    expect(configurations).toHaveLength(2);
  });

  test('keeps an acquired frame valid across a microtask and invalidates it on reconfigure', async () => {
    const context = {
      configure(): void {},
      getCurrentTexture(): object {
        return {
          width: 16, height: 16, depthOrArrayLayers: 1, format: 'bgra8unorm', usage: 16,
          dimension: '2d', mipLevelCount: 1, sampleCount: 1,
          createView(): object { return {}; }
        };
      },
      unconfigure(): void {}
    };
    const nativeDevice = {
      lost: new Promise(() => undefined),
      queue: { submit(): void {}, async onSubmittedWorkDone(): Promise<void> {} },
      addEventListener(): void {}, removeEventListener(): void {}
    };
    const adapter = {
      info: { description: 'Lifetime GPU' }, features: new Set<string>(), limits: {},
      async requestDevice(): Promise<object> { return nativeDevice; }
    };
    const session = await createBrowserGraphics({
      canvas: { getContext(): object { return context; } },
      environment: {
        gpu: { async requestAdapter(): Promise<object> { return adapter; } },
        getCanvasContext(): typeof context { return context; }
      },
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 16, height: 16, alphaMode: 'premultiplied' }
    });

    const acquired = session.surface.acquire();
    if (acquired.status !== 'success') throw new Error('Expected frame.');
    await Promise.resolve();
    expect(acquired.frame.state).toBe('acquired');
    session.resize({ width: 32, height: 16 });
    expect(acquired.frame.state).toBe('released');
    expect(() => acquired.frame.present()).toThrow('Released surface frame cannot be presented.');
    await session.destroy();
  });
});

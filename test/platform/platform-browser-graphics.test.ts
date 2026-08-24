import { describe, expect, test } from 'vitest';
import {
  BrowserGraphicsBootstrapError as PublicBrowserGraphicsBootstrapError,
  createBrowserGraphics
} from '../../src';
import { BrowserGraphicsBootstrapError } from '../../src/platform/browser/browser-graphics-error';

describe('browser graphics bootstrap', () => {
  test('preserves the bootstrap error public runtime identity', () => {
    expect(PublicBrowserGraphicsBootstrapError).toBe(BrowserGraphicsBootstrapError);
  });

  test('probes WebGPU through the adapter before attaching the target canvas', async () => {
    const events: string[] = [];
    const canvas = {
      getContext(): null {
        events.push('canvas.getContext');
        return null;
      }
    };
    const result = createBrowserGraphics({
      canvas,
      preference: ['webgpu', 'webgl2'],
      environment: {
        gpu: {
          async requestAdapter(): Promise<null> {
            events.push('gpu.requestAdapter');
            return null;
          }
        },
        getCanvasContext(target): null {
          return target.getContext('webgpu') as null;
        }
      },
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 640, height: 360 }
    });

    await expect(result).rejects.toBeInstanceOf(BrowserGraphicsBootstrapError);
    await expect(result).rejects.toMatchObject({
      code: 'platform/browser-graphics-unavailable',
      attempts: [
        { backend: 'webgpu', stage: 'adapter', classification: 'unavailable' },
        { backend: 'webgl2', stage: 'environment', classification: 'unavailable' }
      ]
    });
    expect(events).toEqual(['gpu.requestAdapter']);
  });

  test('binds the canvas only after selecting WebGPU and settles loss once', async () => {
    const fixture = createBrowserFixture();
    const session = await createBrowserGraphics({
      canvas: fixture.canvas,
      environment: fixture.environment,
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 640, height: 360, alphaMode: 'opaque' }
    });

    expect(fixture.events.slice(0, 3)).toEqual([
      'gpu.requestAdapter',
      'adapter.requestDevice',
      'canvas.getContext:webgpu'
    ]);
    expect(session.backend).toBe('webgpu');
    expect(session.surface.configuration).toMatchObject({ width: 640, height: 360 });
    expect(fixture.context.configurations).toHaveLength(1);

    const lifecycle: string[] = [];
    const unsubscribe = session.subscribe((event) => lifecycle.push(event.kind));
    session.resize({ width: 800, height: 450 });
    expect(session.surface.generation).toBe(2);
    expect(fixture.context.configurations).toHaveLength(2);
    expect(fixture.canvas).toMatchObject({ width: 800, height: 450 });
    fixture.resolveLost({ reason: 'unknown', message: 'reset' });
    await expect(session.lost).resolves.toMatchObject({
      backend: 'webgpu',
      stage: 'device',
      reason: 'unknown',
      recreationAllowed: true
    });
    expect(lifecycle).toEqual(['reconfigured', 'lost']);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    await session.destroy();
    await session.destroy();
    expect(fixture.context.unconfigures).toBe(1);
  });

  test('rejects invalid size before probing and does not fallback after canvas binding', async () => {
    const fixture = createBrowserFixture();
    await expect(
      createBrowserGraphics({
        canvas: fixture.canvas,
        environment: fixture.environment,
        device: { requiredFeatures: [], optionalFeatures: [] },
        surface: { width: -1, height: 10 }
      })
    ).rejects.toThrow('Browser surface width must be a non-negative integer.');
    expect(fixture.events).toEqual([]);

    const contextFailureEvents: string[] = [];
    await expect(
      createBrowserGraphics({
        canvas: {
          getContext(): null {
            contextFailureEvents.push('canvas.getContext');
            return null;
          }
        },
        preference: ['webgpu', 'webgl2'],
        environment: {
          gpu: {
            async requestAdapter(): Promise<object> {
              contextFailureEvents.push('gpu.requestAdapter');
              return {
                info: { description: 'No Context GPU' },
                features: new Set(),
                limits: {},
                async requestDevice(): Promise<object> {
                  contextFailureEvents.push('adapter.requestDevice');
                  return {
                    lost: new Promise(() => undefined),
                    queue: { submit(): void {}, async onSubmittedWorkDone(): Promise<void> {} },
                    addEventListener(): void {},
                    removeEventListener(): void {},
                    destroy(): void {}
                  };
                }
              };
            }
          },
          getCanvasContext(canvas): null {
            return canvas.getContext('webgpu') as null;
          }
        },
        device: { requiredFeatures: [], optionalFeatures: [] },
        surface: { width: 10, height: 10 }
      })
    ).rejects.toMatchObject({
      attempts: [{ backend: 'webgpu', stage: 'context', classification: 'failure' }]
    });
    expect(contextFailureEvents).toEqual([
      'gpu.requestAdapter',
      'adapter.requestDevice',
      'canvas.getContext'
    ]);
  });

  test('settles terminal canvas acquisition and reconfiguration loss once', async () => {
    const fixture = createBrowserFixture();
    const session = await createBrowserGraphics({
      canvas: fixture.canvas,
      environment: fixture.environment,
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 640, height: 360 }
    });

    fixture.context.getCurrentTexture = () => {
      throw new Error('canvas detached');
    };
    expect(session.surface.acquire()).toEqual({ status: 'lost' });
    await expect(session.lost).resolves.toMatchObject({
      stage: 'surface',
      reason: 'canvas detached',
      recreationAllowed: true
    });

    fixture.context.configure = () => {
      throw new Error('context reset');
    };
    expect(() => session.resize({ width: 800, height: 450 })).toThrow('context reset');
    fixture.resolveLost({ reason: 'unknown', message: 'later device loss' });
    await expect(session.lost).resolves.toMatchObject({
      stage: 'surface',
      reason: 'canvas detached'
    });
  });

  test('falls back after adapter-only WebGPU probing while the canvas is still unattached', async () => {
    const events: string[] = [];
    const gl = createFallbackGL();
    const canvas = {
      width: 0,
      height: 0,
      getContext(kind: string): unknown {
        events.push(`canvas.getContext:${kind}`);
        return kind === 'webgl2' ? gl : null;
      },
      addEventListener(): void {},
      removeEventListener(): void {}
    };
    const session = await createBrowserGraphics({
      canvas,
      preference: ['webgpu', 'webgl2'],
      environment: {
        gpu: {
          async requestAdapter(): Promise<null> {
            events.push('gpu.requestAdapter');
            return null;
          }
        },
        getCanvasContext(): null {
          events.push('canvas.getContext:webgpu');
          return null;
        }
      },
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 64, height: 32 }
    });

    expect(session.backend).toBe('webgl2');
    expect(events).toEqual(['gpu.requestAdapter', 'canvas.getContext:webgl2']);
    expect(canvas).toMatchObject({ width: 64, height: 32 });
    await session.destroy();
  });
});

function createFallbackGL(): object {
  let nextConstant = 1;
  const constants = new Map<string, number>();
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    getSupportedExtensions: () => [],
    getParameter: () => 8,
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    pixelStorei: () => undefined,
    disable: () => undefined,
    colorMask: () => undefined,
    depthMask: () => undefined,
    stencilMask: () => undefined,
    bindBuffer: () => undefined,
    bindFramebuffer: () => undefined,
    bindRenderbuffer: () => undefined,
    bindVertexArray: () => undefined,
    activeTexture: () => undefined
  };
  return new Proxy(methods, {
    get(target, property: string) {
      if (property in target) return target[property];
      let value = constants.get(property);
      if (value === undefined) {
        value = nextConstant++;
        constants.set(property, value);
      }
      return value;
    }
  });
}

function createBrowserFixture() {
  const events: string[] = [];
  let resolveLost!: (value: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });
  const context = {
    configurations: [] as unknown[],
    unconfigures: 0,
    configure(configuration: unknown): void {
      this.configurations.push(configuration);
    },
    getCurrentTexture(): object {
      return {
        width: 640,
        height: 360,
        depthOrArrayLayers: 1,
        format: 'bgra8unorm',
        usage: 16,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
        createView(): object {
          return {};
        }
      };
    },
    unconfigure(): void {
      this.unconfigures += 1;
    }
  };
  const nativeDevice = {
    lost,
    queue: { submit(): void {}, async onSubmittedWorkDone(): Promise<void> {} },
    addEventListener(): void {},
    removeEventListener(): void {},
    destroy(): void {}
  };
  const adapter = {
    info: { description: 'Session GPU' },
    features: new Set<string>(),
    limits: { maxBufferSize: 4096 },
    async requestDevice(): Promise<object> {
      events.push('adapter.requestDevice');
      return nativeDevice;
    }
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(contextId: string): object | null {
      events.push(`canvas.getContext:${contextId}`);
      return contextId === 'webgpu' ? context : null;
    }
  };
  const environment = {
    gpu: {
      getPreferredCanvasFormat(): string {
        return 'bgra8unorm';
      },
      async requestAdapter(): Promise<object> {
        events.push('gpu.requestAdapter');
        return adapter;
      }
    },
    getCanvasContext(target: typeof canvas) {
      return target.getContext('webgpu') as typeof context | null;
    }
  };
  return { canvas, environment, context, events, resolveLost };
}

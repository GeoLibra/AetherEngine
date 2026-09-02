import { describe, expect, test } from 'vitest';
import { getBrowserWebGPUEnvironment } from '../../../src';

describe('browser WebGPU environment', () => {
  test('rejects a global object without navigator.gpu', () => {
    expect(() => getBrowserWebGPUEnvironment({ navigator: {} })).toThrowError(
      'WebGPU is unavailable: navigator.gpu is missing'
    );
  });

  test('returns null when the canvas cannot create a WebGPU context', () => {
    const gpu = Object.freeze({ requestAdapter: async () => null });
    const environment = getBrowserWebGPUEnvironment({ navigator: { gpu } });
    const requested: string[] = [];

    const context = environment.getCanvasContext({
      getContext(contextId: string): null {
        requested.push(contextId);
        return null;
      }
    });

    expect(context).toBeNull();
    expect(requested).toEqual(['webgpu']);
  });

  test('uses injected GPU and canvas objects without reading browser globals', () => {
    const gpu = Object.freeze({ requestAdapter: async () => null });
    const canvasContext = Object.freeze({ configure(): void {} });
    const environment = getBrowserWebGPUEnvironment({ navigator: { gpu } });

    expect(environment.gpu).toBe(gpu);
    expect(
      environment.getCanvasContext({
        getContext(contextId: string): unknown {
          return contextId === 'webgpu' ? canvasContext : null;
        }
      })
    ).toBe(canvasContext);
  });
});

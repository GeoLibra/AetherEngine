import { describe, expect, test } from 'vitest';

import { createBrowserWebGL2ContextPort } from '../../../src/rhi/webgl2/browser/context-port';

describe('browser WebGL2 loss and recreation readiness', () => {
  test('settles loss once and reinitializes baseline before announcing restoration', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const calls: string[] = [];
    const methods = {
      getSupportedExtensions: () => [],
      getParameter: () => 8,
      getShaderPrecisionFormat: () => ({ precision: 23 }),
      pixelStorei: () => calls.push('pixelStorei'),
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
    let constant = 1;
    const gl = new Proxy(methods, {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target];
        return constant++;
      }
    });
    const canvas = {
      getContext: () => gl,
      addEventListener(type: string, listener: (event: unknown) => void): void {
        listeners.set(type, listener);
      },
      removeEventListener(type: string): void {
        listeners.delete(type);
      }
    };
    const port = createBrowserWebGL2ContextPort(canvas);
    if (port === null) throw new Error('Expected context.');
    const initializations = calls.length;
    let prevented = 0;
    listeners.get('webglcontextlost')?.({
      preventDefault: () => {
        prevented += 1;
      },
      statusMessage: 'reset'
    });
    listeners.get('webglcontextlost')?.({
      preventDefault: () => {
        prevented += 1;
      }
    });
    await expect(port.lost).resolves.toMatchObject({ reason: 'context-lost', message: 'reset' });
    expect(prevented).toBe(1);

    listeners.get('webglcontextrestored')?.({});
    await expect(port.restored).resolves.toBeUndefined();
    expect(calls.length).toBeGreaterThan(initializations);
    port.destroy?.();
    expect(listeners.size).toBe(0);
  });
});

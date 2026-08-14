import { describe, expect, test } from 'vitest';

import { createBrowserWebGL2OperationPort } from '../../../src/rhi/webgl2/browser/operation-port';

describe('browser WebGL2 bindings', () => {
  test('uses queried physical slots without offset rounding or texture-unit aliasing', () => {
    const calls: unknown[][] = [];
    const gl = {
      UNIFORM_BUFFER: 0x8a11,
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      bindBufferRange: (...args: unknown[]) => calls.push(['bindBufferRange', ...args]),
      activeTexture: (...args: unknown[]) => calls.push(['activeTexture', ...args]),
      bindTexture: (...args: unknown[]) => calls.push(['bindTexture', ...args]),
      bindSampler: (...args: unknown[]) => calls.push(['bindSampler', ...args])
    };
    const port = createBrowserWebGL2OperationPort(gl);
    const buffer = {};
    const texture = {};
    const samplerA = {};
    const samplerB = {};

    port.bindUniformBuffer?.(3, buffer, 512, 128);
    port.bindTexture?.(1, texture);
    port.bindSampler?.(1, samplerA);
    port.bindTexture?.(2, texture);
    port.bindSampler?.(2, samplerB);

    expect(calls).toEqual([
      ['bindBufferRange', gl.UNIFORM_BUFFER, 3, buffer, 512, 128],
      ['activeTexture', gl.TEXTURE0 + 1],
      ['bindTexture', gl.TEXTURE_2D, texture],
      ['bindSampler', 1, samplerA],
      ['activeTexture', gl.TEXTURE0 + 2],
      ['bindTexture', gl.TEXTURE_2D, texture],
      ['bindSampler', 2, samplerB]
    ]);
  });
});

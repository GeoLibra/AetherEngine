import { describe, expect, test } from 'vitest';

import { queryWebGL2Formats } from '../../../src/rhi/webgl2/browser/capability-query';
import type { BrowserWebGL2Context } from '../../../src/rhi/webgl2/browser/types';

const context = {
  MAX_SAMPLES: 0x8d57,
  getParameter: () => 4,
  getSupportedExtensions: () => [],
  getShaderPrecisionFormat: () => null,
  pixelStorei() {},
  disable() {},
  colorMask() {},
  depthMask() {},
  stencilMask() {},
  bindBuffer() {},
  bindFramebuffer() {},
  bindRenderbuffer() {},
  bindVertexArray() {},
  activeTexture() {}
} satisfies BrowserWebGL2Context & { readonly MAX_SAMPLES: number };

describe('WebGL2 copy capability publication', () => {
  test('rejects sRGB source copies while retaining encoded upload destination support', () => {
    const formats = queryWebGL2Formats(context, new Set());
    expect(formats.get('rgba8unorm-srgb')).toMatchObject({
      sample: true,
      render: true,
      copySrc: false,
      copyDst: true
    });
  });

  test('does not advertise unsupported depth copies as a consequence of render support', () => {
    const formats = queryWebGL2Formats(context, new Set());
    expect(formats.get('depth24plus')).toMatchObject({
      render: true,
      copySrc: false,
      copyDst: false
    });
    expect(formats.get('rgba8unorm')).toMatchObject({ copySrc: true, copyDst: true });
  });
});

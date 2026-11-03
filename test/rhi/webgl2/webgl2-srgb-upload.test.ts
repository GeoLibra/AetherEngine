import { expect, test } from 'vitest';
import { createBrowserWebGL2TextureCopyPort } from '../../../src/rhi/webgl2/browser/operations/texture-copy-port';
import type { BrowserWebGL2TextureFacts } from '../../../src/rhi/webgl2/browser/operations/resource-port';

test('uploads encoded sRGB bytes without allowing color-converting texture readback', () => {
  const calls: unknown[][] = [];
  const gl = {
    PIXEL_UNPACK_BUFFER: 0x88ec,
    TEXTURE_2D: 0x0de1,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_ROW_LENGTH: 0x0cf2,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    bindBuffer: (...args: unknown[]) => calls.push(['bindBuffer', ...args]),
    pixelStorei: (...args: unknown[]) => calls.push(['pixelStorei', ...args]),
    bindTexture: (...args: unknown[]) => calls.push(['bindTexture', ...args]),
    texSubImage2D: (...args: unknown[]) => calls.push(['texSubImage2D', ...args])
  };
  const texture = {};
  const facts = new WeakMap<object, BrowserWebGL2TextureFacts>();
  facts.set(texture, {
    format: 'rgba8unorm-srgb',
    width: 1,
    height: 1,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    storage: 'texture',
    target: 'TEXTURE_2D',
    aspect: 'color'
  });
  const port = createBrowserWebGL2TextureCopyPort(gl, facts);
  const pixels = new Uint8Array([128, 64, 32, 255]);
  port.writeTexture!({ texture }, pixels, { bytesPerRow: 4 }, { width: 1, height: 1 });
  expect(calls).toContainEqual(['texSubImage2D', 0x0de1, 0, 0, 0, 1, 1, 0x1908, 0x1401, pixels]);
  port.copyBufferToTexture!({ buffer: {}, bytesPerRow: 4 }, { texture }, { width: 1, height: 1 });
  expect(calls).toContainEqual(['texSubImage2D', 0x0de1, 0, 0, 0, 1, 1, 0x1908, 0x1401, 0]);
  expect(() =>
    port.copyTextureToBuffer!({ texture }, { buffer: {} }, { width: 1, height: 1 })
  ).toThrow(/sRGB/);
});

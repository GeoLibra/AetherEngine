import { createBrowserWebGL2TextureCopyPort } from '../src/rhi/webgl2/browser/operations/texture-copy-port';
import type { BrowserWebGL2TextureFacts } from '../src/rhi/webgl2/browser/operations/resource-port';

/** Measures encoded sRGB upload lowering against the same raw native-call boundary. */
export function runWebGlSrgbUploadWorkload(count: number, raw: boolean) {
  let uploads = 0;
  let bytes = 0;
  let checksum = 0;
  const gl = {
    PIXEL_UNPACK_BUFFER: 0x88ec,
    TEXTURE_2D: 0x0de1,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_ROW_LENGTH: 0x0cf2,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    bindBuffer() {},
    pixelStorei() {},
    bindTexture() {},
    texSubImage2D(...args: unknown[]) {
      if (args[6] !== 0x1908 || args[7] !== 0x1401 || !(args[8] instanceof Uint8Array))
        throw new Error('sRGB uploads must preserve RGBA encoded-byte transfer semantics.');
      uploads++;
      bytes += args[8].byteLength;
      checksum += args[8][0]!;
    }
  };
  const texture = {};
  const facts = new WeakMap<object, BrowserWebGL2TextureFacts>();
  facts.set(texture, {
    width: 1,
    height: 1,
    depthOrArrayLayers: 1,
    storage: 'texture',
    target: 'TEXTURE_2D',
    format: 'rgba8unorm-srgb',
    aspect: 'color',
    mipLevelCount: 1,
    sampleCount: 1
  });
  const port = createBrowserWebGL2TextureCopyPort(gl, facts);
  const pixels = new Uint8Array([128, 64, 32, 255]);
  for (let i = 0; i < count; i++) {
    if (raw) {
      gl.bindBuffer();
      gl.pixelStorei();
      gl.pixelStorei();
      gl.bindTexture();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.pixelStorei();
    } else port.writeTexture!({ texture }, pixels, { bytesPerRow: 4 }, { width: 1, height: 1 });
  }
  return { uploads, bytes, checksum };
}

import type { WebGL2NativeContextPort } from '../types';
import { constant } from './capability-query';
import { glCall, glObject } from './gl-call';
import { requiredNumber, requiredRecord } from './resource-port';
import type { BrowserWebGL2TextureFacts } from './resource-port';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2TextureCopyPort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>
): Pick<
  WebGL2NativeContextPort,
  'writeTexture' | 'copyBufferToTexture' | 'copyTextureToBuffer' | 'copyTextureToTexture'
> {
  return {
    writeTexture(destination, data, layout, size): void {
      const copy = textureCopy(destination, textureFacts);
      const extent = copyExtent(size);
      requireBaselineExtent(extent);
      glCall(gl, 'bindBuffer', [constant(gl, 'PIXEL_UNPACK_BUFFER'), null]);
      setAlignment(gl, 'UNPACK_ALIGNMENT', 4);
      setRowLength(gl, 'UNPACK_ROW_LENGTH', layout.bytesPerRow, 4);
      glCall(gl, 'bindTexture', [constant(gl, 'TEXTURE_2D'), copy.texture]);
      const offset = layout.offset ?? 0;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + offset, data.byteLength - offset);
      texSubImage(gl, copy, extent, bytes);
      setRowLength(gl, 'UNPACK_ROW_LENGTH', 0, 4);
    },
    copyBufferToTexture(source, destination, size): void {
      const copy = textureCopy(destination, textureFacts);
      const extent = copyExtent(size);
      requireBaselineExtent(extent);
      const buffer = requiredObject(source, 'buffer');
      glCall(gl, 'bindBuffer', [constant(gl, 'PIXEL_UNPACK_BUFFER'), buffer]);
      setAlignment(gl, 'UNPACK_ALIGNMENT', 4);
      setRowLength(gl, 'UNPACK_ROW_LENGTH', source.bytesPerRow, 4);
      glCall(gl, 'bindTexture', [constant(gl, 'TEXTURE_2D'), copy.texture]);
      texSubImage(gl, copy, extent, numberField(source, 'offset', 0));
      setRowLength(gl, 'UNPACK_ROW_LENGTH', 0, 4);
      glCall(gl, 'bindBuffer', [constant(gl, 'PIXEL_UNPACK_BUFFER'), null]);
    },
    copyTextureToBuffer(source, destination, size): void {
      const copy = textureCopy(source, textureFacts);
      const extent = copyExtent(size);
      requireBaselineExtent(extent);
      const buffer = requiredObject(destination, 'buffer');
      withReadFramebuffer(gl, copy.texture, copy.mipLevel, () => {
        glCall(gl, 'bindBuffer', [constant(gl, 'PIXEL_PACK_BUFFER'), buffer]);
        setAlignment(gl, 'PACK_ALIGNMENT', 4);
        setRowLength(gl, 'PACK_ROW_LENGTH', destination.bytesPerRow, 4);
        glCall(gl, 'readPixels', [
          copy.x,
          copy.y,
          extent.width,
          extent.height,
          constant(gl, 'RGBA'),
          constant(gl, 'UNSIGNED_BYTE'),
          numberField(destination, 'offset', 0)
        ]);
        setRowLength(gl, 'PACK_ROW_LENGTH', 0, 4);
        glCall(gl, 'bindBuffer', [constant(gl, 'PIXEL_PACK_BUFFER'), null]);
      });
    },
    copyTextureToTexture(source, destination, size): void {
      const sourceCopy = textureCopy(source, textureFacts);
      const destinationCopy = textureCopy(destination, textureFacts);
      const extent = copyExtent(size);
      requireBaselineExtent(extent);
      withReadFramebuffer(gl, sourceCopy.texture, sourceCopy.mipLevel, () => {
        glCall(gl, 'bindTexture', [constant(gl, 'TEXTURE_2D'), destinationCopy.texture]);
        glCall(gl, 'copyTexSubImage2D', [
          constant(gl, 'TEXTURE_2D'),
          destinationCopy.mipLevel,
          destinationCopy.x,
          destinationCopy.y,
          sourceCopy.x,
          sourceCopy.y,
          extent.width,
          extent.height
        ]);
      });
    }
  };
}

interface TextureCopy {
  readonly texture: object;
  readonly mipLevel: number;
  readonly x: number;
  readonly y: number;
}
interface CopyExtent {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
}

function textureCopy(
  value: Readonly<Record<string, unknown>>,
  facts: WeakMap<object, BrowserWebGL2TextureFacts>
): TextureCopy {
  const texture = requiredObject(value, 'texture');
  const textureFacts = facts.get(texture);
  if (textureFacts === undefined || textureFacts.format !== 'rgba8unorm') {
    throw new Error('WebGL2 baseline texture copy supports owned rgba8unorm textures only.');
  }
  const origin =
    typeof value.origin === 'object' && value.origin !== null
      ? (value.origin as Readonly<Record<string, unknown>>)
      : {};
  return {
    texture,
    mipLevel: numberField(value, 'mipLevel', 0),
    x: numberField(origin, 'x', 0),
    y: numberField(origin, 'y', 0)
  };
}

function copyExtent(value: Readonly<Record<string, number>>): CopyExtent {
  return {
    width: requiredNumber(value, 'width'),
    height: requiredNumber(value, 'height'),
    depthOrArrayLayers: value.depthOrArrayLayers ?? 1
  };
}

function requireBaselineExtent(extent: CopyExtent): void {
  if (extent.depthOrArrayLayers !== 1)
    throw new Error('WebGL2 baseline texture copy supports one 2D layer only.');
}

function texSubImage(
  gl: BrowserWebGL2Object,
  copy: TextureCopy,
  extent: CopyExtent,
  data: unknown
): void {
  glCall(gl, 'texSubImage2D', [
    constant(gl, 'TEXTURE_2D'),
    copy.mipLevel,
    copy.x,
    copy.y,
    extent.width,
    extent.height,
    constant(gl, 'RGBA'),
    constant(gl, 'UNSIGNED_BYTE'),
    data
  ]);
}

function withReadFramebuffer(
  gl: BrowserWebGL2Object,
  texture: object,
  mipLevel: number,
  action: () => void
): void {
  const framebuffer = glObject(gl, 'createFramebuffer');
  try {
    glCall(gl, 'bindFramebuffer', [constant(gl, 'FRAMEBUFFER'), framebuffer]);
    glCall(gl, 'framebufferTexture2D', [
      constant(gl, 'FRAMEBUFFER'),
      constant(gl, 'COLOR_ATTACHMENT0'),
      constant(gl, 'TEXTURE_2D'),
      texture,
      mipLevel
    ]);
    action();
  } finally {
    glCall(gl, 'deleteFramebuffer', [framebuffer]);
  }
}

function setAlignment(gl: BrowserWebGL2Object, name: string, value: number): void {
  glCall(gl, 'pixelStorei', [constant(gl, name), value]);
}

function requiredObject(value: Readonly<Record<string, unknown>>, name: string): object {
  const field = value[name];
  if (typeof field !== 'object' || field === null)
    throw new TypeError(`${name} must be an object.`);
  return field;
}

function numberField(
  value: Readonly<Record<string, unknown>>,
  name: string,
  fallback: number
): number {
  const field = value[name];
  return typeof field === 'number' ? field : fallback;
}

function setRowLength(
  gl: BrowserWebGL2Object,
  name: string,
  bytesPerRow: unknown,
  bytesPerPixel: number
): void {
  const value = typeof bytesPerRow === 'number' ? bytesPerRow / bytesPerPixel : 0;
  if (!Number.isInteger(value)) throw new Error(`WebGL2 ${name} requires whole texel rows.`);
  glCall(gl, 'pixelStorei', [constant(gl, name), value]);
}

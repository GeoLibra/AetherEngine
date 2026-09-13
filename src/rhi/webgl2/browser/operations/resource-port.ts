import type { WebGL2NativeContextPort } from '../../types';
import { constant } from '../capability-query';
import { glCall, glObject } from '../gl-call';
import type { BrowserWebGL2Object } from '../types';

export interface BrowserWebGL2TextureFacts {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly target: 'TEXTURE_2D' | 'TEXTURE_2D_ARRAY';
  readonly format: string;
  readonly aspect: 'color' | 'depth' | 'depth-stencil';
  readonly mipLevelCount: number;
}

export type BrowserWebGL2BufferTarget = 'ARRAY_BUFFER' | 'ELEMENT_ARRAY_BUFFER';

export function createBrowserWebGL2ResourcePort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>,
  bufferTargets: WeakMap<object, BrowserWebGL2BufferTarget> = new WeakMap()
): Pick<
  WebGL2NativeContextPort,
  | 'createBuffer'
  | 'deleteBuffer'
  | 'createTexture'
  | 'deleteTexture'
  | 'createSampler'
  | 'deleteSampler'
> {
  return {
    createBuffer(descriptor) {
      const buffer = glObject(gl, 'createBuffer');
      const usage = requiredNumber(descriptor, 'usage');
      const target: BrowserWebGL2BufferTarget =
        (usage & (1 << 4)) !== 0 ? 'ELEMENT_ARRAY_BUFFER' : 'ARRAY_BUFFER';
      bufferTargets.set(buffer, target);
      const uploadVertexArray =
        target === 'ELEMENT_ARRAY_BUFFER' ? glObject(gl, 'createVertexArray') : undefined;
      if (uploadVertexArray !== undefined) glCall(gl, 'bindVertexArray', [uploadVertexArray]);
      glCall(gl, 'bindBuffer', [constant(gl, target), buffer]);
      glCall(gl, 'bufferData', [
        constant(gl, target),
        requiredNumber(descriptor, 'size'),
        constant(gl, 'DYNAMIC_DRAW')
      ]);
      if (uploadVertexArray !== undefined) {
        glCall(gl, 'bindVertexArray', [null]);
        glCall(gl, 'deleteVertexArray', [uploadVertexArray]);
      }
      return buffer;
    },
    deleteBuffer(buffer): void {
      glCall(gl, 'deleteBuffer', [buffer]);
    },
    createTexture(descriptor) {
      const size = requiredRecord(descriptor, 'size');
      const width = requiredNumber(size, 'width');
      const height = requiredNumber(size, 'height');
      const depthOrArrayLayers = optionalNumber(size, 'depthOrArrayLayers') ?? 1;
      if (!Number.isInteger(depthOrArrayLayers) || depthOrArrayLayers < 1) {
        throw new TypeError('Texture depthOrArrayLayers must be a positive integer.');
      }
      const texture = glObject(gl, 'createTexture');
      const target: BrowserWebGL2TextureFacts['target'] =
        depthOrArrayLayers === 1 ? 'TEXTURE_2D' : 'TEXTURE_2D_ARRAY';
      glCall(gl, 'bindTexture', [constant(gl, target), texture]);
      const format = textureFormat(gl, descriptor.format);
      const mipLevelCount = optionalNumber(descriptor, 'mipLevelCount') ?? 1;
      if (target === 'TEXTURE_2D') {
        glCall(gl, 'texStorage2D', [
          constant(gl, target),
          mipLevelCount,
          format.internalFormat,
          width,
          height
        ]);
      } else {
        glCall(gl, 'texStorage3D', [
          constant(gl, target),
          mipLevelCount,
          format.internalFormat,
          width,
          height,
          depthOrArrayLayers
        ]);
      }
      // WebGL defaults require a complete mip chain. RHI textures must remain complete when
      // textureLoad/texelFetch is used without a separately bound sampler.
      glCall(gl, 'texParameteri', [
        constant(gl, target),
        constant(gl, 'TEXTURE_MIN_FILTER'),
        constant(gl, 'NEAREST')
      ]);
      glCall(gl, 'texParameteri', [
        constant(gl, target),
        constant(gl, 'TEXTURE_MAG_FILTER'),
        constant(gl, 'NEAREST')
      ]);
      glCall(gl, 'texParameteri', [
        constant(gl, target),
        constant(gl, 'TEXTURE_WRAP_S'),
        constant(gl, 'CLAMP_TO_EDGE')
      ]);
      glCall(gl, 'texParameteri', [
        constant(gl, target),
        constant(gl, 'TEXTURE_WRAP_T'),
        constant(gl, 'CLAMP_TO_EDGE')
      ]);
      textureFacts.set(texture, {
        width,
        height,
        depthOrArrayLayers,
        target,
        format: String(descriptor.format),
        aspect: format.aspect,
        mipLevelCount
      });
      return texture;
    },
    deleteTexture(texture): void {
      textureFacts.delete(texture);
      glCall(gl, 'deleteTexture', [texture]);
    },
    createSampler(descriptor) {
      const sampler = glObject(gl, 'createSampler');
      const min =
        descriptor.mipmapFilter !== undefined
          ? samplerMinFilter(gl, descriptor.minFilter, descriptor.mipmapFilter)
          : filter(gl, descriptor.minFilter);
      glCall(gl, 'samplerParameteri', [sampler, constant(gl, 'TEXTURE_MIN_FILTER'), min]);
      glCall(gl, 'samplerParameteri', [
        sampler,
        constant(gl, 'TEXTURE_MAG_FILTER'),
        filter(gl, descriptor.magFilter)
      ]);
      {
        glCall(gl, 'samplerParameteri', [
          sampler,
          constant(gl, 'TEXTURE_WRAP_S'),
          wrapMode(gl, descriptor.addressModeU)
        ]);
      }
      {
        glCall(gl, 'samplerParameteri', [
          sampler,
          constant(gl, 'TEXTURE_WRAP_T'),
          wrapMode(gl, descriptor.addressModeV)
        ]);
      }
      {
        glCall(gl, 'samplerParameteri', [
          sampler,
          constant(gl, 'TEXTURE_WRAP_R'),
          wrapMode(gl, descriptor.addressModeW)
        ]);
      }
      if (typeof descriptor.compare === 'string') {
        glCall(gl, 'samplerParameteri', [
          sampler,
          constant(gl, 'TEXTURE_COMPARE_MODE'),
          constant(gl, 'COMPARE_REF_TO_TEXTURE')
        ]);
        glCall(gl, 'samplerParameteri', [
          sampler,
          constant(gl, 'TEXTURE_COMPARE_FUNC'),
          compareFunction(gl, descriptor.compare)
        ]);
      }
      return sampler;
    },
    deleteSampler(sampler): void {
      glCall(gl, 'deleteSampler', [sampler]);
    }
  };
}

function textureFormat(
  gl: BrowserWebGL2Object,
  value: unknown
): { readonly internalFormat: number; readonly aspect: BrowserWebGL2TextureFacts['aspect'] } {
  if (value === 'rgba8unorm') return { internalFormat: constant(gl, 'RGBA8'), aspect: 'color' };
  if (value === 'rgba8unorm-srgb')
    return { internalFormat: constant(gl, 'SRGB8_ALPHA8'), aspect: 'color' };
  if (value === 'rgba32uint') return { internalFormat: constant(gl, 'RGBA32UI'), aspect: 'color' };
  if (value === 'depth24plus')
    return { internalFormat: constant(gl, 'DEPTH_COMPONENT24'), aspect: 'depth' };
  if (value === 'depth24plus-stencil8')
    return { internalFormat: constant(gl, 'DEPTH24_STENCIL8'), aspect: 'depth-stencil' };
  if (value === 'rgba16float') return { internalFormat: constant(gl, 'RGBA16F'), aspect: 'color' };
  throw new Error(`Unsupported WebGL2 texture format: ${String(value)}.`);
}

function filter(gl: BrowserWebGL2Object, value: unknown): number {
  return constant(gl, value === 'linear' ? 'LINEAR' : 'NEAREST');
}

function wrapMode(gl: BrowserWebGL2Object, value: unknown): number {
  if (value === 'repeat') return constant(gl, 'REPEAT');
  if (value === 'mirror-repeat') return constant(gl, 'MIRRORED_REPEAT');
  return constant(gl, 'CLAMP_TO_EDGE');
}

function samplerMinFilter(gl: BrowserWebGL2Object, min: unknown, mipmap: unknown): number {
  if (mipmap === 'linear') {
    return constant(gl, min === 'linear' ? 'LINEAR_MIPMAP_LINEAR' : 'NEAREST_MIPMAP_LINEAR');
  }
  if (mipmap === 'nearest') {
    return constant(gl, min === 'linear' ? 'LINEAR_MIPMAP_NEAREST' : 'NEAREST_MIPMAP_NEAREST');
  }
  return constant(gl, min === 'linear' ? 'LINEAR' : 'NEAREST');
}

function compareFunction(gl: BrowserWebGL2Object, value: string): number {
  const names: Readonly<Record<string, string>> = {
    never: 'NEVER',
    less: 'LESS',
    equal: 'EQUAL',
    'less-equal': 'LEQUAL',
    greater: 'GREATER',
    'not-equal': 'NOTEQUAL',
    'greater-equal': 'GEQUAL',
    always: 'ALWAYS'
  };
  const name = names[value];
  if (name === undefined) throw new Error(`Unsupported WebGL2 sampler compare function: ${value}.`);
  return constant(gl, name);
}

export function requiredRecord(
  value: Readonly<Record<string, unknown>>,
  name: string
): Readonly<Record<string, unknown>> {
  const field = value[name];
  if (typeof field !== 'object' || field === null)
    throw new TypeError(`${name} must be an object.`);
  return field as Readonly<Record<string, unknown>>;
}

export function requiredNumber(value: Readonly<Record<string, unknown>>, name: string): number {
  const field = value[name];
  if (typeof field !== 'number' || !Number.isFinite(field))
    throw new TypeError(`${name} must be numeric.`);
  return field;
}

function optionalNumber(
  value: Readonly<Record<string, unknown>>,
  name: string
): number | undefined {
  const field = value[name];
  return typeof field === 'number' ? field : undefined;
}

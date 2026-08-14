import type { WebGL2NativeContextPort, WebGL2NativeObject } from '../native-types';
import { constant } from './capability-query';
import { glCall, glObject } from './gl-call';
import type { BrowserWebGL2Object } from './types';

export interface BrowserWebGL2TextureFacts {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export function createBrowserWebGL2ResourcePort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>
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
      glCall(gl, 'bindBuffer', [constant(gl, 'ARRAY_BUFFER'), buffer]);
      glCall(gl, 'bufferData', [
        constant(gl, 'ARRAY_BUFFER'),
        requiredNumber(descriptor, 'size'),
        constant(gl, 'DYNAMIC_DRAW')
      ]);
      return buffer;
    },
    deleteBuffer(buffer): void {
      glCall(gl, 'deleteBuffer', [buffer]);
    },
    createTexture(descriptor) {
      const size = requiredRecord(descriptor, 'size');
      const width = requiredNumber(size, 'width');
      const height = requiredNumber(size, 'height');
      const texture = glObject(gl, 'createTexture');
      glCall(gl, 'bindTexture', [constant(gl, 'TEXTURE_2D'), texture]);
      glCall(gl, 'texStorage2D', [
        constant(gl, 'TEXTURE_2D'),
        optionalNumber(descriptor, 'mipLevelCount') ?? 1,
        textureFormat(gl, descriptor.format),
        width,
        height
      ]);
      textureFacts.set(texture, { width, height, format: String(descriptor.format) });
      return texture;
    },
    deleteTexture(texture): void {
      textureFacts.delete(texture);
      glCall(gl, 'deleteTexture', [texture]);
    },
    createSampler(descriptor) {
      const sampler = glObject(gl, 'createSampler');
      glCall(gl, 'samplerParameteri', [
        sampler,
        constant(gl, 'TEXTURE_MIN_FILTER'),
        filter(gl, descriptor.minFilter)
      ]);
      glCall(gl, 'samplerParameteri', [
        sampler,
        constant(gl, 'TEXTURE_MAG_FILTER'),
        filter(gl, descriptor.magFilter)
      ]);
      return sampler;
    },
    deleteSampler(sampler): void {
      glCall(gl, 'deleteSampler', [sampler]);
    }
  };
}

function textureFormat(gl: BrowserWebGL2Object, value: unknown): number {
  if (value === 'rgba8unorm') return constant(gl, 'RGBA8');
  if (value === 'depth24plus') return constant(gl, 'DEPTH_COMPONENT24');
  if (value === 'depth24plus-stencil8') return constant(gl, 'DEPTH24_STENCIL8');
  if (value === 'rgba16float') return constant(gl, 'RGBA16F');
  throw new Error(`Unsupported WebGL2 texture format: ${String(value)}.`);
}

function filter(gl: BrowserWebGL2Object, value: unknown): number {
  return constant(gl, value === 'linear' ? 'LINEAR' : 'NEAREST');
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

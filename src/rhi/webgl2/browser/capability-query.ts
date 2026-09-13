import type { FormatCapabilities } from '../../contracts/capability';
import type { GPUTextureFormat } from '../../contracts/webgpu';
import type { WebGL2NativeLimits } from '../types';
import type { BrowserWebGL2Context, BrowserWebGL2Object } from './types';

export function queryWebGL2Extensions(gl: BrowserWebGL2Context): Set<string> {
  return new Set(gl.getSupportedExtensions() ?? []);
}

export function queryWebGL2Limits(gl: BrowserWebGL2Context): WebGL2NativeLimits {
  return Object.freeze({
    maxTextureUnits: numberParameter(gl, 'MAX_COMBINED_TEXTURE_IMAGE_UNITS'),
    maxTextureDimension2D: numberParameter(gl, 'MAX_TEXTURE_SIZE'),
    maxUniformBufferBindings: numberParameter(gl, 'MAX_UNIFORM_BUFFER_BINDINGS'),
    maxUniformBlockSize: numberParameter(gl, 'MAX_UNIFORM_BLOCK_SIZE'),
    uniformBufferOffsetAlignment: numberParameter(gl, 'UNIFORM_BUFFER_OFFSET_ALIGNMENT'),
    maxDrawBuffers: numberParameter(gl, 'MAX_DRAW_BUFFERS'),
    maxColorAttachments: numberParameter(gl, 'MAX_COLOR_ATTACHMENTS'),
    maxSampleCount: numberParameter(gl, 'MAX_SAMPLES')
  });
}

export function queryWebGL2Precision(gl: BrowserWebGL2Context): Readonly<Record<string, number>> {
  return Object.freeze({
    vertexHighFloatBits: precision(gl, 'VERTEX_SHADER'),
    fragmentHighFloatBits: precision(gl, 'FRAGMENT_SHADER')
  });
}

export const COLOR_BUFFER_FLOAT_EXTENSION = 'EXT_color_buffer_float';
export const TEXTURE_FLOAT_LINEAR_EXTENSION = 'OES_texture_float_linear';

export function queryWebGL2Formats(
  gl: BrowserWebGL2Context,
  extensions: ReadonlySet<string>
): ReadonlyMap<GPUTextureFormat, FormatCapabilities> {
  const maxSamples = numberParameter(gl, 'MAX_SAMPLES');
  const sampleCounts = maxSamples >= 4 ? [1, 4] : [1];
  const formats = new Map<GPUTextureFormat, FormatCapabilities>();
  formats.set('rgba8unorm', format(true, true, true, true, sampleCounts));
  formats.set('rgba8unorm-srgb', format(true, true, true, true, sampleCounts));
  // RGBA32UI color rendering and integer sampling are core WebGL2 capabilities.
  formats.set('rgba32uint', format(true, false, true, false, [1]));
  formats.set('depth24plus', format(false, false, true, false, sampleCounts));
  if (extensions.has(COLOR_BUFFER_FLOAT_EXTENSION)) {
    // Half-float linear filtering is core in WebGL2; OES_texture_float_linear
    // controls 32-bit floating-point filtering, not RGBA16F.
    formats.set('rgba16float', format(true, true, true, false, sampleCounts));
  }
  return formats;
}

function format(
  sample: boolean,
  filter: boolean,
  render: boolean,
  blend: boolean,
  sampleCounts: readonly number[]
): FormatCapabilities {
  return Object.freeze({
    sample,
    filter,
    render,
    blend,
    storage: false,
    copySrc: true,
    copyDst: true,
    sampleCounts: Object.freeze([...sampleCounts])
  });
}

function numberParameter(gl: BrowserWebGL2Context, name: string): number {
  const parameter = constant(gl, name);
  const value = gl.getParameter(parameter);
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`WebGL2 ${name} is not numeric.`);
  return value;
}

function precision(gl: BrowserWebGL2Context, shader: string): number {
  return (
    gl.getShaderPrecisionFormat(constant(gl, shader), constant(gl, 'HIGH_FLOAT'))?.precision ?? 0
  );
}

export function constant(gl: BrowserWebGL2Object, name: string): number {
  const value = Reflect.get(gl, name);
  if (typeof value !== 'number') throw new Error(`WebGL2 context does not expose ${name}.`);
  return value;
}

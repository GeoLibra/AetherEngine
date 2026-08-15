import type { WebGL2NativeContextPort } from '../types';
import { constant } from './capability-query';
import { glCall } from './gl-call';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2BindingPort(
  gl: BrowserWebGL2Object
): Pick<WebGL2NativeContextPort, 'bindUniformBuffer' | 'bindTexture' | 'bindSampler'> {
  return {
    bindUniformBuffer(binding, buffer, offset, size): void {
      glCall(gl, 'bindBufferRange', [
        constant(gl, 'UNIFORM_BUFFER'),
        binding,
        buffer,
        offset,
        size
      ]);
    },
    bindTexture(unit, texture): void {
      glCall(gl, 'activeTexture', [constant(gl, 'TEXTURE0') + unit]);
      glCall(gl, 'bindTexture', [constant(gl, 'TEXTURE_2D'), texture]);
    },
    bindSampler(unit, sampler): void {
      glCall(gl, 'bindSampler', [unit, sampler]);
    }
  };
}

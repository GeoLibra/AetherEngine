import type { WebGL2NativeContextPort } from '../../types';
import { constant } from '../capability-query';
import { glCall } from '../gl-call';
import type { BrowserWebGL2Object } from '../types';
import type { BrowserWebGL2TextureFacts } from './resource-port';

export function createBrowserWebGL2BindingPort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>
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
      const facts = textureFacts.get(texture);
      if (facts?.storage === 'renderbuffer') {
        throw new Error('WebGL2 multisample renderbuffers cannot be bound as sampled textures.');
      }
      const target = facts?.target ?? 'TEXTURE_2D';
      glCall(gl, 'activeTexture', [constant(gl, 'TEXTURE0') + unit]);
      glCall(gl, 'bindTexture', [constant(gl, target), texture]);
    },
    bindSampler(unit, sampler): void {
      glCall(gl, 'bindSampler', [unit, sampler]);
    }
  };
}

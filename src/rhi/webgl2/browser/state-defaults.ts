import { constant } from './capability-query';
import type { BrowserWebGL2Context } from './types';

const ALL_STENCIL_BITS = 0xffffffff;

export function initializeWebGL2StateDefaults(gl: BrowserWebGL2Context): void {
  gl.pixelStorei(constant(gl, 'PACK_ALIGNMENT'), 4);
  gl.pixelStorei(constant(gl, 'UNPACK_ALIGNMENT'), 4);
  for (const capability of ['BLEND', 'CULL_FACE', 'DEPTH_TEST', 'SCISSOR_TEST', 'STENCIL_TEST']) {
    gl.disable(constant(gl, capability));
  }
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  gl.stencilMask(ALL_STENCIL_BITS);
  for (const target of [
    'ARRAY_BUFFER',
    'ELEMENT_ARRAY_BUFFER',
    'UNIFORM_BUFFER',
    'COPY_READ_BUFFER',
    'COPY_WRITE_BUFFER',
    'PIXEL_PACK_BUFFER',
    'PIXEL_UNPACK_BUFFER'
  ]) {
    gl.bindBuffer(constant(gl, target), null);
  }
  gl.bindFramebuffer(constant(gl, 'FRAMEBUFFER'), null);
  gl.bindRenderbuffer(constant(gl, 'RENDERBUFFER'), null);
  gl.bindVertexArray(null);
  gl.activeTexture(constant(gl, 'TEXTURE0'));
}

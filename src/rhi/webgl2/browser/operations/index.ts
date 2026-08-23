import type { WebGL2NativeContextPort } from '../../types';
import type { BrowserWebGL2Object } from '../types';
import { createBrowserWebGL2BindingPort } from './binding-port';
import { createBrowserWebGL2CopyPort } from './copy-port';
import { createBrowserWebGL2FramebufferPort } from './framebuffer-port';
import { createBrowserWebGL2ProgramPort } from './program-port';
import { createBrowserWebGL2RenderPassOperations } from './render-pass-operations';
import { createBrowserWebGL2RenderPort } from './render-port';
import { createBrowserWebGL2ResourcePort, type BrowserWebGL2TextureFacts } from './resource-port';
import { createBrowserWebGL2TextureCopyPort } from './texture-copy-port';

export function createBrowserWebGL2OperationPort(
  gl: BrowserWebGL2Object
): Partial<WebGL2NativeContextPort> {
  const textureFacts = new WeakMap<object, BrowserWebGL2TextureFacts>();
  const framebufferState = { current: null as object | null };
  return {
    ...createBrowserWebGL2ResourcePort(gl, textureFacts),
    ...createBrowserWebGL2RenderPort(gl, textureFacts),
    ...createBrowserWebGL2CopyPort(gl),
    ...createBrowserWebGL2FramebufferPort(gl, textureFacts, framebufferState),
    ...createBrowserWebGL2TextureCopyPort(gl, textureFacts),
    ...createBrowserWebGL2RenderPassOperations(gl, textureFacts, framebufferState),
    ...createBrowserWebGL2BindingPort(gl),
    ...createBrowserWebGL2ProgramPort(gl)
  };
}

export {
  createBrowserWebGL2BindingPort,
  createBrowserWebGL2CopyPort,
  createBrowserWebGL2FramebufferPort,
  createBrowserWebGL2ProgramPort,
  createBrowserWebGL2RenderPassOperations,
  createBrowserWebGL2RenderPort,
  createBrowserWebGL2ResourcePort,
  createBrowserWebGL2TextureCopyPort
};
export type { BrowserWebGL2TextureFacts };

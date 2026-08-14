import type { WebGL2NativeContextPort } from '../native-types';
import { constant } from './capability-query';
import type { BrowserWebGL2FramebufferState } from './framebuffer-port';
import { glCall, glObject } from './gl-call';
import type { BrowserWebGL2TextureFacts } from './resource-port';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2RenderPassOperations(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>,
  framebufferState: BrowserWebGL2FramebufferState
): Pick<
  WebGL2NativeContextPort,
  | 'applyRenderPassLoadOperations'
  | 'applyRenderPassStoreOperations'
  | 'resolveRenderPass'
  | 'presentSurfaceTexture'
> {
  return {
    applyRenderPassLoadOperations(descriptor): void {
      for (const [index, attachment] of colorAttachments(descriptor).entries()) {
        if (Reflect.get(attachment, 'loadOp') !== 'clear') continue;
        const value = colorValue(Reflect.get(attachment, 'clearValue'));
        glCall(gl, 'clearBufferfv', [constant(gl, 'COLOR'), index, value]);
      }
      const depth = objectField(descriptor, 'depthStencilAttachment');
      if (depth?.depthLoadOp === 'clear') {
        glCall(gl, 'clearBufferfv', [
          constant(gl, 'DEPTH'),
          0,
          new Float32Array([numberValue(depth.depthClearValue, 1)])
        ]);
      }
      if (depth?.stencilLoadOp === 'clear') {
        glCall(gl, 'clearBufferiv', [
          constant(gl, 'STENCIL'),
          0,
          new Int32Array([numberValue(depth.stencilClearValue, 0)])
        ]);
      }
    },
    applyRenderPassStoreOperations(descriptor): void {
      const discarded: number[] = [];
      colorAttachments(descriptor).forEach((attachment, index) => {
        if (Reflect.get(attachment, 'storeOp') === 'discard') {
          discarded.push(constant(gl, 'COLOR_ATTACHMENT0') + index);
        }
      });
      const depth = objectField(descriptor, 'depthStencilAttachment');
      if (depth?.depthStoreOp === 'discard') discarded.push(constant(gl, 'DEPTH_ATTACHMENT'));
      if (depth?.stencilStoreOp === 'discard') discarded.push(constant(gl, 'STENCIL_ATTACHMENT'));
      if (discarded.length > 0) {
        glCall(gl, 'invalidateFramebuffer', [constant(gl, 'FRAMEBUFFER'), discarded]);
      }
    },
    resolveRenderPass(descriptor): void {
      for (const attachment of colorAttachments(descriptor)) {
        const target = Reflect.get(attachment, 'resolveTarget');
        if (typeof target !== 'object' || target === null) continue;
        const source = attachmentView(attachment);
        const sourceFacts = requiredFacts(textureFacts, source);
        const targetFacts = requiredFacts(textureFacts, target);
        if (sourceFacts.width !== targetFacts.width || sourceFacts.height !== targetFacts.height) {
          throw new Error('WebGL2 resolve attachments must have equal extents.');
        }
        const resolveFramebuffer = glObject(gl, 'createFramebuffer');
        try {
          glCall(gl, 'bindFramebuffer', [constant(gl, 'DRAW_FRAMEBUFFER'), resolveFramebuffer]);
          glCall(gl, 'framebufferTexture2D', [
            constant(gl, 'DRAW_FRAMEBUFFER'),
            constant(gl, 'COLOR_ATTACHMENT0'),
            constant(gl, 'TEXTURE_2D'),
            target,
            0
          ]);
          glCall(gl, 'blitFramebuffer', [
            0,
            0,
            sourceFacts.width,
            sourceFacts.height,
            0,
            0,
            targetFacts.width,
            targetFacts.height,
            constant(gl, 'COLOR_BUFFER_BIT'),
            constant(gl, 'NEAREST')
          ]);
        } finally {
          glCall(gl, 'bindFramebuffer', [
            constant(gl, 'DRAW_FRAMEBUFFER'),
            framebufferState.current
          ]);
          glCall(gl, 'deleteFramebuffer', [resolveFramebuffer]);
        }
      }
    },
    presentSurfaceTexture(texture, width, height): void {
      const read = glObject(gl, 'createFramebuffer');
      glCall(gl, 'bindFramebuffer', [constant(gl, 'READ_FRAMEBUFFER'), read]);
      glCall(gl, 'framebufferTexture2D', [
        constant(gl, 'READ_FRAMEBUFFER'),
        constant(gl, 'COLOR_ATTACHMENT0'),
        constant(gl, 'TEXTURE_2D'),
        texture,
        0
      ]);
      glCall(gl, 'bindFramebuffer', [constant(gl, 'DRAW_FRAMEBUFFER'), null]);
      glCall(gl, 'blitFramebuffer', [
        0,
        0,
        width,
        height,
        0,
        0,
        width,
        height,
        constant(gl, 'COLOR_BUFFER_BIT'),
        constant(gl, 'NEAREST')
      ]);
      glCall(gl, 'deleteFramebuffer', [read]);
      framebufferState.current = null;
    }
  };
}

function colorAttachments(descriptor: Readonly<Record<string, unknown>>): object[] {
  return Array.isArray(descriptor.colorAttachments)
    ? descriptor.colorAttachments.filter(
        (value): value is object => typeof value === 'object' && value !== null
      )
    : [];
}

function colorValue(value: unknown): Float32Array {
  if (typeof value !== 'object' || value === null) return new Float32Array([0, 0, 0, 0]);
  return new Float32Array([
    numberValue(Reflect.get(value, 'r'), 0),
    numberValue(Reflect.get(value, 'g'), 0),
    numberValue(Reflect.get(value, 'b'), 0),
    numberValue(Reflect.get(value, 'a'), 0)
  ]);
}

function objectField(
  value: Readonly<Record<string, unknown>>,
  name: string
): Record<string, unknown> | undefined {
  const field = value[name];
  return typeof field === 'object' && field !== null
    ? (field as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function attachmentView(attachment: object): object {
  const view = Reflect.get(attachment, 'view');
  if (typeof view !== 'object' || view === null)
    throw new Error('WebGL2 resolve source is invalid.');
  return view;
}

function requiredFacts(facts: WeakMap<object, BrowserWebGL2TextureFacts>, texture: object) {
  const result = facts.get(texture);
  if (result === undefined)
    throw new Error('WebGL2 resolve attachment is not owned by this context.');
  return result;
}

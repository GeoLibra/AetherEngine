import type { WebGL2NativeContextPort } from '../native-types';
import { constant } from './capability-query';
import { glCall, glObject } from './gl-call';
import type { BrowserWebGL2TextureFacts } from './resource-port';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2FramebufferPort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>,
  state: BrowserWebGL2FramebufferState
): Pick<
  WebGL2NativeContextPort,
  | 'createFramebuffer'
  | 'checkFramebufferStatus'
  | 'bindFramebuffer'
  | 'deleteFramebuffer'
  | 'createVertexArray'
  | 'bindVertexArray'
  | 'deleteVertexArray'
> {
  return {
    createFramebuffer(descriptor) {
      const framebuffer = glObject(gl, 'createFramebuffer');
      glCall(gl, 'bindFramebuffer', [constant(gl, 'FRAMEBUFFER'), framebuffer]);
      const colors = descriptor.colorAttachments;
      if (Array.isArray(colors))
        colors.forEach((attachment, index) => {
          const texture = attachmentView(attachment);
          requireTexture(textureFacts, texture);
          glCall(gl, 'framebufferTexture2D', [
            constant(gl, 'FRAMEBUFFER'),
            constant(gl, 'COLOR_ATTACHMENT0') + index,
            constant(gl, 'TEXTURE_2D'),
            texture,
            0
          ]);
        });
      const depth = descriptor.depthStencilAttachment;
      if (typeof depth === 'object' && depth !== null) {
        const texture = attachmentView(depth);
        const facts = requireTexture(textureFacts, texture);
        glCall(gl, 'framebufferTexture2D', [
          constant(gl, 'FRAMEBUFFER'),
          constant(
            gl,
            facts.format.includes('stencil') ? 'DEPTH_STENCIL_ATTACHMENT' : 'DEPTH_ATTACHMENT'
          ),
          constant(gl, 'TEXTURE_2D'),
          texture,
          0
        ]);
      }
      return framebuffer;
    },
    checkFramebufferStatus() {
      const status = glCall(gl, 'checkFramebufferStatus', [constant(gl, 'FRAMEBUFFER')]);
      const complete = status === constant(gl, 'FRAMEBUFFER_COMPLETE');
      return Object.freeze({
        complete,
        status: complete ? 'FRAMEBUFFER_COMPLETE' : `0x${Number(status).toString(16)}`
      });
    },
    bindFramebuffer(framebuffer): void {
      glCall(gl, 'bindFramebuffer', [constant(gl, 'FRAMEBUFFER'), framebuffer]);
      state.current = framebuffer;
    },
    deleteFramebuffer(framebuffer): void {
      glCall(gl, 'deleteFramebuffer', [framebuffer]);
    },
    createVertexArray(descriptor) {
      const vertexArray = glObject(gl, 'createVertexArray');
      glCall(gl, 'bindVertexArray', [vertexArray]);
      configureVertexArray(gl, descriptor);
      return vertexArray;
    },
    bindVertexArray(vertexArray): void {
      glCall(gl, 'bindVertexArray', [vertexArray]);
    },
    deleteVertexArray(vertexArray): void {
      glCall(gl, 'deleteVertexArray', [vertexArray]);
    }
  };
}

function configureVertexArray(
  gl: BrowserWebGL2Object,
  descriptor: Readonly<Record<string, unknown>>
): void {
  const layouts = descriptor.vertexLayout;
  const buffers = descriptor.vertexBuffers;
  if (!Array.isArray(layouts) || !Array.isArray(buffers))
    throw new TypeError('WebGL2 vertex array requires vertexLayout and vertexBuffers arrays.');
  const bySlot = new Map<number, Readonly<Record<string, unknown>>>();
  for (const value of buffers) {
    if (typeof value !== 'object' || value === null) continue;
    const slot = Reflect.get(value, 'slot');
    if (typeof slot === 'number') bySlot.set(slot, value as Readonly<Record<string, unknown>>);
  }
  layouts.forEach((layout, slot) => {
    if (layout === null) return;
    if (typeof layout !== 'object')
      throw new TypeError(`Invalid vertex buffer layout at slot ${slot}.`);
    const binding = bySlot.get(slot);
    if (binding === undefined) throw new Error(`WebGL2 vertex buffer slot ${slot} is not bound.`);
    const buffer = binding.buffer;
    if (typeof buffer !== 'object' || buffer === null)
      throw new TypeError(`Invalid WebGL2 vertex buffer at slot ${slot}.`);
    glCall(gl, 'bindBuffer', [constant(gl, 'ARRAY_BUFFER'), buffer]);
    const stride = numeric(layout, 'arrayStride');
    const baseOffset = numeric(binding, 'offset');
    const divisor = layout.stepMode === 'instance' ? 1 : 0;
    const attributes = layout.attributes;
    if (!Array.isArray(attributes))
      throw new TypeError(`Invalid vertex attributes at slot ${slot}.`);
    for (const attribute of attributes) {
      if (typeof attribute !== 'object' || attribute === null)
        throw new TypeError(`Invalid vertex attribute at slot ${slot}.`);
      const location = numeric(attribute, 'shaderLocation');
      const format = vertexFormat(gl, attribute.format);
      glCall(gl, 'enableVertexAttribArray', [location]);
      glCall(gl, format.integer ? 'vertexAttribIPointer' : 'vertexAttribPointer', [
        location,
        format.components,
        format.type,
        ...(format.integer ? [] : [format.normalized]),
        stride,
        baseOffset + numeric(attribute, 'offset')
      ]);
      glCall(gl, 'vertexAttribDivisor', [location, divisor]);
    }
  });
  const index = descriptor.indexBuffer;
  if (typeof index === 'object' && index !== null) {
    const buffer = Reflect.get(index, 'buffer');
    if (typeof buffer !== 'object' || buffer === null)
      throw new TypeError('Invalid WebGL2 index buffer.');
    glCall(gl, 'bindBuffer', [constant(gl, 'ELEMENT_ARRAY_BUFFER'), buffer]);
  }
}

function numeric(value: object, key: string): number {
  const result = Reflect.get(value, key);
  if (typeof result !== 'number') throw new TypeError(`Expected numeric ${key}.`);
  return result;
}

function vertexFormat(
  gl: BrowserWebGL2Object,
  value: unknown
): {
  components: number;
  type: number;
  normalized: boolean;
  integer: boolean;
} {
  const formats: Record<string, [number, string, boolean, boolean]> = {
    float32: [1, 'FLOAT', false, false],
    float32x2: [2, 'FLOAT', false, false],
    float32x3: [3, 'FLOAT', false, false],
    float32x4: [4, 'FLOAT', false, false],
    uint32: [1, 'UNSIGNED_INT', false, true],
    uint32x2: [2, 'UNSIGNED_INT', false, true],
    uint32x3: [3, 'UNSIGNED_INT', false, true],
    uint32x4: [4, 'UNSIGNED_INT', false, true],
    unorm8x4: [4, 'UNSIGNED_BYTE', true, false]
  };
  const format = typeof value === 'string' ? formats[value] : undefined;
  if (format === undefined) throw new Error(`Unsupported WebGL2 vertex format: ${String(value)}.`);
  return {
    components: format[0],
    type: constant(gl, format[1]),
    normalized: format[2],
    integer: format[3]
  };
}

export interface BrowserWebGL2FramebufferState {
  current: object | null;
}

function attachmentView(value: unknown): object {
  if (typeof value !== 'object' || value === null)
    throw new TypeError('Framebuffer attachment is invalid.');
  const view = Reflect.get(value, 'view');
  if (typeof view !== 'object' || view === null)
    throw new TypeError('Framebuffer attachment view is invalid.');
  return view;
}

function requireTexture(
  facts: WeakMap<object, BrowserWebGL2TextureFacts>,
  texture: object
): BrowserWebGL2TextureFacts {
  const result = facts.get(texture);
  if (result === undefined)
    throw new Error('Framebuffer attachment is not owned by this browser WebGL2 context.');
  return result;
}

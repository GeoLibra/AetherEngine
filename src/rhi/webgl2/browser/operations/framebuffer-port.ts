import type { WebGL2NativeContextPort } from '../../types';
import { constant } from '../capability-query';
import { glCall, glObject } from '../gl-call';
import type { BrowserWebGL2TextureFacts } from './resource-port';
import { textureSubresource } from './texture-subresource';
import type { BrowserWebGL2Object } from '../types';

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
      validateAttachmentExtents(descriptor, textureFacts);
      const framebuffer = glObject(gl, 'createFramebuffer');
      glCall(gl, 'bindFramebuffer', [constant(gl, 'FRAMEBUFFER'), framebuffer]);
      const colors = descriptor.colorAttachments;
      const drawBuffers: number[] = [];
      if (Array.isArray(colors))
        colors.forEach((attachment, index) => {
          if (typeof attachment !== 'object' || attachment === null)
            throw new TypeError('Framebuffer color attachment is invalid.');
          const subresource = attachmentSubresource(attachment, textureFacts);
          const attachmentPoint = constant(gl, 'COLOR_ATTACHMENT0') + index;
          glCall(gl, 'framebufferTexture2D', [
            constant(gl, 'FRAMEBUFFER'),
            attachmentPoint,
            constant(gl, 'TEXTURE_2D'),
            subresource.texture,
            subresource.mipLevel
          ]);
          drawBuffers.push(attachmentPoint);
        });
      if (drawBuffers.length > 0) {
        glCall(gl, 'drawBuffers', [drawBuffers]);
      } else {
        glCall(gl, 'drawBuffers', [[constant(gl, 'NONE')]]);
        glCall(gl, 'readBuffer', [constant(gl, 'NONE')]);
      }
      const depth = descriptor.depthStencilAttachment;
      if (typeof depth === 'object' && depth !== null) {
        const subresource = attachmentSubresource(depth, textureFacts);
        glCall(gl, 'framebufferTexture2D', [
          constant(gl, 'FRAMEBUFFER'),
          constant(
            gl,
            subresource.facts.aspect === 'depth-stencil'
              ? 'DEPTH_STENCIL_ATTACHMENT'
              : 'DEPTH_ATTACHMENT'
          ),
          constant(gl, 'TEXTURE_2D'),
          subresource.texture,
          subresource.mipLevel
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

function validateAttachmentExtents(
  descriptor: Readonly<Record<string, unknown>>,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>
): void {
  let expected: { readonly width: number; readonly height: number } | undefined;
  const validate = (attachment: unknown) => {
    if (typeof attachment !== 'object' || attachment === null)
      throw new TypeError('Framebuffer attachment is invalid.');
    const subresource = attachmentSubresource(attachment, textureFacts);
    if (expected === undefined) {
      expected = subresource;
    } else if (subresource.width !== expected.width || subresource.height !== expected.height) {
      throw new Error(
        `WebGL2 framebuffer attachment extent mismatch: expected ${expected.width}x${expected.height}, received ${subresource.width}x${subresource.height}.`
      );
    }
    return subresource;
  };
  if (Array.isArray(descriptor.colorAttachments)) {
    for (const attachment of descriptor.colorAttachments) {
      const source = validate(attachment);
      if (typeof attachment !== 'object' || attachment === null) continue;
      const resolveTarget = Reflect.get(attachment, 'resolveTarget');
      if (typeof resolveTarget !== 'object' || resolveTarget === null) continue;
      const target = textureSubresource(attachment, textureFacts, {
        texture: 'resolveTarget',
        mipLevel: 'resolveTargetMipLevel',
        width: 'resolveTargetWidth',
        height: 'resolveTargetHeight'
      });
      if (source.width !== target.width || source.height !== target.height) {
        throw new Error(
          `WebGL2 resolve attachment extent mismatch: source ${source.width}x${source.height}, target ${target.width}x${target.height}.`
        );
      }
    }
  }
  if (
    typeof descriptor.depthStencilAttachment === 'object' &&
    descriptor.depthStencilAttachment !== null
  ) {
    validate(descriptor.depthStencilAttachment);
  }
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

function attachmentSubresource(
  attachment: object,
  facts: WeakMap<object, BrowserWebGL2TextureFacts>
) {
  return textureSubresource(attachment, facts, {
    texture: 'view',
    mipLevel: 'mipLevel',
    width: 'width',
    height: 'height'
  });
}

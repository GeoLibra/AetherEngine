import type { WebGL2NativeContextPort, WebGL2NativeObject } from '../native-types';
import { constant } from './capability-query';
import { glCall } from './gl-call';
import type { BrowserWebGL2TextureFacts } from './resource-port';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2RenderPort(
  gl: BrowserWebGL2Object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>
): Pick<
  WebGL2NativeContextPort,
  | 'beginRenderPass'
  | 'endRenderPass'
  | 'setViewport'
  | 'setScissorRect'
  | 'setRasterState'
  | 'setDepthStencilState'
  | 'bindIndexBuffer'
  | 'draw'
  | 'drawIndexed'
> {
  let framebufferHeight: number | undefined;
  let topology: number | undefined;
  let indexType: number | undefined;
  let indexElementSize = 2;
  let indexOffset = 0;
  return {
    beginRenderPass(descriptor): void {
      const attachments = descriptor.colorAttachments;
      if (Array.isArray(attachments)) {
        const first = attachments[0];
        if (typeof first === 'object' && first !== null) {
          const view = Reflect.get(first, 'view');
          if (typeof view === 'object' && view !== null)
            framebufferHeight = textureFacts.get(view)?.height;
        }
      }
    },
    endRenderPass(): void {
      framebufferHeight = undefined;
    },
    setViewport(x, y, width, height, minDepth, maxDepth): void {
      glCall(gl, 'viewport', [x, lowerY(framebufferHeight, y, height), width, height]);
      glCall(gl, 'depthRange', [minDepth, maxDepth]);
    },
    setScissorRect(x, y, width, height): void {
      glCall(gl, 'scissor', [x, lowerY(framebufferHeight, y, height), width, height]);
    },
    setRasterState(state): void {
      topology = primitiveTopology(gl, state.topology);
      const cullMode = state.cullMode;
      glCall(gl, cullMode === 'none' ? 'disable' : 'enable', [constant(gl, 'CULL_FACE')]);
      if (cullMode !== 'none')
        glCall(gl, 'cullFace', [constant(gl, cullMode === 'front' ? 'FRONT' : 'BACK')]);
      glCall(gl, 'frontFace', [constant(gl, state.frontFace === 'cw' ? 'CW' : 'CCW')]);
    },
    setDepthStencilState(state): void {
      const enabled = state.enabled === true;
      glCall(gl, enabled ? 'enable' : 'disable', [constant(gl, 'DEPTH_TEST')]);
      if (!enabled) return;
      glCall(gl, 'depthMask', [state.depthWriteEnabled === true]);
      glCall(gl, 'depthFunc', [compareFunction(gl, state.depthCompare)]);
    },
    bindIndexBuffer(buffer, format, offset): void {
      glCall(gl, 'bindBuffer', [constant(gl, 'ELEMENT_ARRAY_BUFFER'), buffer]);
      indexType = constant(gl, format === 'uint32' ? 'UNSIGNED_INT' : 'UNSIGNED_SHORT');
      indexElementSize = format === 'uint32' ? 4 : 2;
      indexOffset = offset;
    },
    draw(vertexCount, instanceCount, firstVertex, firstInstance): void {
      rejectBaseInstance(firstInstance);
      glCall(gl, 'drawArraysInstanced', [
        topology ?? constant(gl, 'TRIANGLES'),
        firstVertex,
        vertexCount,
        instanceCount
      ]);
    },
    drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance): void {
      if (baseVertex !== 0) throw new Error('WebGL2 does not support non-zero baseVertex.');
      rejectBaseInstance(firstInstance);
      glCall(gl, 'drawElementsInstanced', [
        topology ?? constant(gl, 'TRIANGLES'),
        indexCount,
        indexType ?? constant(gl, 'UNSIGNED_SHORT'),
        indexOffset + firstIndex * indexElementSize,
        instanceCount
      ]);
    }
  };
}

function compareFunction(gl: BrowserWebGL2Object, value: unknown): number {
  const names: Record<string, string> = {
    never: 'NEVER',
    less: 'LESS',
    equal: 'EQUAL',
    'less-equal': 'LEQUAL',
    greater: 'GREATER',
    'not-equal': 'NOTEQUAL',
    'greater-equal': 'GEQUAL',
    always: 'ALWAYS'
  };
  return constant(gl, names[typeof value === 'string' ? value : 'less'] ?? 'LESS');
}

function lowerY(framebufferHeight: number | undefined, y: number, height: number): number {
  if (framebufferHeight === undefined)
    throw new Error('WebGL2 viewport/scissor requires an active attachment extent.');
  return framebufferHeight - y - height;
}

function primitiveTopology(gl: BrowserWebGL2Object, value: unknown): number {
  if (value === 'point-list') return constant(gl, 'POINTS');
  if (value === 'line-list') return constant(gl, 'LINES');
  if (value === 'line-strip') return constant(gl, 'LINE_STRIP');
  if (value === 'triangle-strip') return constant(gl, 'TRIANGLE_STRIP');
  return constant(gl, 'TRIANGLES');
}

function rejectBaseInstance(value: number): void {
  if (value !== 0) throw new Error('WebGL2 does not support non-zero firstInstance.');
}

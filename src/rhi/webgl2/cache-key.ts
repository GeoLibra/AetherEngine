import type { RHIRenderPipeline } from '../contracts/resource';
import type { WebGL2RenderPassSnapshot } from './command-types';
import type { WebGL2Buffer } from './resource';

export interface WebGL2VertexBufferState {
  readonly buffer: WebGL2Buffer;
  readonly offset: number;
  readonly size?: number;
}

export interface WebGL2IndexBufferState extends WebGL2VertexBufferState {
  readonly format: string;
}

export function createFramebufferCacheKey(descriptor: WebGL2RenderPassSnapshot, generation: number): string {
  const colors = descriptor.colorAttachments.map((attachment) => [
    viewKey(attachment.view),
    attachment.resolveTarget === undefined ? '-' : viewKey(attachment.resolveTarget),
    attachment.view.texture.descriptor.sampleCount ?? 1
  ].join('>'));
  const depth = descriptor.depthStencilAttachment === undefined
    ? '-'
    : viewKey(descriptor.depthStencilAttachment.view);
  return `g${generation}|c:${colors.join(',')}|d:${depth}`;
}

export function createVertexArrayCacheKey(
  pipeline: RHIRenderPipeline,
  vertexBuffers: ReadonlyMap<number, WebGL2VertexBufferState>,
  indexBuffer: WebGL2IndexBufferState | undefined
): string {
  const layout = JSON.stringify(pipeline.descriptor.vertex?.buffers ?? []);
  const vertices = [...vertexBuffers.entries()].sort(([a], [b]) => a - b).map(([slot, state]) =>
    `${slot}:${state.buffer.id}@${state.buffer.generation}:${state.offset}:${state.size ?? '*'}:` +
    `${pipeline.descriptor.vertex?.buffers?.[slot]?.arrayStride ?? 0}`
  );
  const index = indexBuffer === undefined
    ? '-'
    : `${indexBuffer.buffer.id}@${indexBuffer.buffer.generation}:${indexBuffer.offset}:${indexBuffer.size ?? '*'}:${indexBuffer.format}`;
  return `g${pipeline.generation}|l:${layout}|v:${vertices.join(',')}|i:${index}`;
}

function viewKey(view: WebGL2RenderPassSnapshot['colorAttachments'][number]['view']): string {
  const descriptor = view.descriptor;
  return [
    `${view.id}@${view.generation}`,
    descriptor.baseMipLevel ?? 0,
    descriptor.mipLevelCount ?? 1,
    descriptor.baseArrayLayer ?? 0,
    descriptor.arrayLayerCount ?? view.depthOrArrayLayers,
    view.format
  ].join(':');
}

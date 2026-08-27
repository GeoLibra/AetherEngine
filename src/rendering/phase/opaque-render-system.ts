import type { TextureHandle } from '../../render-graph';
import { createPreparedDrawResourcesToken } from '../../render-graph';
import type { OpaqueRenderSystemInput, OpaqueRenderSystemPreparation } from './types';
import { ReadonlyMapSnapshot } from '../world/readonly-collection-snapshot';

/**
 * Creates one per-view opaque RenderSystem that records prepared indexed draws and presents.
 *
 * Pipeline compilation, material resolution, resource creation, queue submission, and ownership
 * retention remain outside the pass callback.
 *
 * @throws When the phase is not opaque or attachment descriptors are incompatible.
 */
export function createOpaqueRenderSystem(
  input: OpaqueRenderSystemInput
): OpaqueRenderSystemPreparation {
  validateInput(input);
  const bindings = new Map(
    input.phase.packets.map((packet, index) => [
      createPreparedDrawResourcesToken(`${input.phase.viewId}:opaque:${index}`),
      packet
    ])
  );
  const entries = [...bindings];
  const descriptor: OpaqueRenderSystemPreparation['descriptor'] = {
    id: input.id ?? 'opaque-draw',
    scope: 'per-view',
    runIf: ({ view }) => view?.id === input.phase.viewId,
    setup(pass) {
      const surface = pass.createTexture(input.color, {
        origin: {
          kind: 'imported',
          initialState: 'undefined',
          acquire: { kind: 'external-acquire', id: input.surfaceFrame.id }
        }
      });
      const depth = pass.createTexture(input.depth);
      const color = pass.writeTexture(surface, 'color-attachment');
      const depthAttachment = pass.writeTexture(depth, 'depth-stencil-attachment');
      pass.presentTexture(color, input.surfaceFrame);
      return Object.freeze({ color, depth: depthAttachment });
    },
    run(context, resources) {
      const attachments = resources as { color: TextureHandle; depth: TextureHandle };
      const draws = entries.map(([token]) => context.drawResources(token));
      const raster = context.beginRaster({
        label: 'opaque-draw',
        colorAttachments: [
          {
            texture: attachments.color,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 }
          }
        ],
        depthStencilAttachment: {
          texture: attachments.depth,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1
        }
      });
      raster.setViewport(0, 0, input.color.width, input.color.height, 0, 1);
      raster.setScissorRect(0, 0, input.color.width, input.color.height);
      for (const draw of draws) {
        raster.setPipeline(draw.pipeline);
        draw.bindGroups.forEach((group, index) =>
          raster.setBindGroup(index, group, draw.dynamicOffsetsByGroup[index])
        );
        draw.vertexBuffers.forEach((buffer, index) => raster.setVertexBuffer(index, buffer));
        raster.setIndexBuffer(draw.indexBuffer, draw.indexFormat);
        raster.drawIndexed(draw.indexCount, 1, draw.firstIndex);
      }
      raster.end();
    }
  };
  return Object.freeze({
    preparedDrawResources: new ReadonlyMapSnapshot(bindings),
    descriptor
  });
}

function validateInput(input: OpaqueRenderSystemInput): void {
  if (input.phase.phase !== 'opaque')
    throw new Error('Opaque RenderSystem requires an opaque phase.');
  if (!input.color.usage.includes('color-attachment'))
    throw new Error('Opaque RenderSystem color output requires color-attachment usage.');
  if (!input.depth.usage.includes('depth-stencil-attachment'))
    throw new Error('Opaque RenderSystem depth output requires depth-stencil-attachment usage.');
  if (
    input.color.width !== input.depth.width ||
    input.color.height !== input.depth.height ||
    input.color.sampleCount !== input.depth.sampleCount
  )
    throw new Error('Opaque RenderSystem color and depth attachments must match.');
}

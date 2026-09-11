import type { RasterPassContext } from '../../../render-graph';
import type { ShadowDepthPassRecord } from './shadow-graph';

/**
 * Records every prepared caster packet declared for one shadow layer.
 *
 * Packets must use a depth-compatible pipeline and carry the cascade-specific view bind group.
 * The declaration boundary enforces that only tokens listed on the pass can be resolved here.
 */
export function recordPreparedShadowDraws(
  context: RasterPassContext,
  pass: ShadowDepthPassRecord
): void {
  const extent = pass.request.resolutionClass;
  context.raster.setViewport(0, 0, extent, extent, 0, 1);
  context.raster.setScissorRect(0, 0, extent, extent);
  for (const token of pass.draws) {
    const draw = context.drawResources(token);
    context.raster.setPipeline(draw.pipeline);
    draw.bindGroups.forEach((group, index) => {
      context.raster.setBindGroup(index, group, draw.dynamicOffsetsByGroup[index]);
    });
    draw.vertexBuffers.forEach((buffer, index) => {
      context.raster.setVertexBuffer(index, buffer);
    });
    context.raster.setIndexBuffer(draw.indexBuffer, draw.indexFormat);
    context.raster.drawIndexed(draw.indexCount, 1, draw.firstIndex);
  }
}

import type { GPUPrimitiveTopology, RHICommandStats, RHIDrawStats } from '../contracts';

export function createCommandStats(): RHICommandStats {
  return {
    renderPasses: 0,
    computePasses: 0,
    draw: createDrawStats(),
    compute: {
      dispatchWorkgroups: 0,
      dispatchWorkgroupsIndirect: 0
    },
    copy: {
      copyBufferToBuffer: 0,
      copyTextureToTexture: 0,
      copyBufferToTexture: 0,
      copyTextureToBuffer: 0
    }
  };
}

export function cloneCommandStats(stats: RHICommandStats): RHICommandStats {
  return {
    renderPasses: stats.renderPasses,
    computePasses: stats.computePasses,
    draw: { ...stats.draw },
    compute: { ...stats.compute },
    copy: { ...stats.copy }
  };
}

export function recordDraw(
  stats: RHICommandStats,
  vertexCount: number,
  instanceCount: number,
  topology: GPUPrimitiveTopology | undefined
): void {
  stats.draw.drawCalls += 1;
  stats.draw.instanceCount += instanceCount;
  stats.draw.vertexCount += vertexCount * instanceCount;
  stats.draw.triangleCountEstimate += estimateTriangles(topology, vertexCount) * instanceCount;
}

export function recordIndexedDraw(
  stats: RHICommandStats,
  indexCount: number,
  instanceCount: number,
  topology: GPUPrimitiveTopology | undefined
): void {
  stats.draw.indexedDrawCalls += 1;
  stats.draw.instanceCount += instanceCount;
  stats.draw.indexCount += indexCount * instanceCount;
  stats.draw.triangleCountEstimate += estimateTriangles(topology, indexCount) * instanceCount;
}

export function recordIndirectDraw(stats: RHICommandStats): void {
  stats.draw.indirectDrawCalls += 1;
  stats.draw.unknownVertexOrIndexCount = true;
}

function createDrawStats(): RHIDrawStats {
  return {
    drawCalls: 0,
    indexedDrawCalls: 0,
    indirectDrawCalls: 0,
    instanceCount: 0,
    vertexCount: 0,
    indexCount: 0,
    unknownVertexOrIndexCount: false,
    triangleCountEstimate: 0
  };
}

function estimateTriangles(topology: GPUPrimitiveTopology | undefined, count: number): number {
  if (topology === 'triangle-list') {
    return Math.floor(count / 3);
  }
  if (topology === 'triangle-strip') {
    return Math.max(count - 2, 0);
  }
  return 0;
}

import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { createOpaqueRenderSystem } from '../../src/rendering/phase/opaque-render-system';

describe('baseline MSAA graph wiring', () => {
  test('resolves a 4x HDR opaque attachment into a 1x post-color source', () => {
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture(texture('rgba16float', 4));
    const resolved = graph.createTexture(texture('rgba16float', 1));
    const depth = graph.createTexture(texture('depth24plus', 4, 'depth-stencil-attachment'));
    const opaque = createOpaqueRenderSystem({
      phase: { viewId: 'main', phase: 'opaque', packets: [] },
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: texture('rgba16float', 4),
      depth: texture('depth24plus', 4, 'depth-stencil-attachment'),
      colorTarget: color,
      depthTarget: depth,
      resolveTarget: resolved,
      present: false
    });
    graph.addRasterPass(opaque.descriptor as never);

    const snapshot = graph.build();
    const pass = snapshot.passes[0]!;
    expect(pass.rasterDetails!.resolveAttachments).toHaveLength(1);
    expect(pass.rasterDetails!.resolveAttachments[0]!.destination.resourceId).toBe(
      resolved.resourceId
    );
  });

  test('keeps the 1x path free of a resolve attachment', () => {
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture(texture('rgba16float', 1));
    const depth = graph.createTexture(texture('depth24plus', 1, 'depth-stencil-attachment'));
    const opaque = createOpaqueRenderSystem({
      phase: { viewId: 'main', phase: 'opaque', packets: [] },
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: texture('rgba16float', 1),
      depth: texture('depth24plus', 1, 'depth-stencil-attachment'),
      colorTarget: color,
      depthTarget: depth,
      present: false
    });
    graph.addRasterPass(opaque.descriptor as never);

    expect(graph.build().passes[0]!.rasterDetails!.resolveAttachments).toHaveLength(0);
  });
});

function texture(
  format: 'rgba16float' | 'depth24plus',
  sampleCount: 1 | 4,
  usage: 'color-attachment' | 'depth-stencil-attachment' = 'color-attachment'
) {
  return {
    width: 16,
    height: 16,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount,
    format,
    usage: [usage]
  } as const;
}

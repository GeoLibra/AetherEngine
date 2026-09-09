import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import type { TextureDescriptor } from '../../src/render-graph/types';

function colorTexture(sampleCount = 1): TextureDescriptor {
  return {
    width: 16,
    height: 16,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount,
    format: 'rgba8unorm',
    usage: ['color-attachment']
  };
}

describe('render graph raster declaration validation', () => {
  test('canonicalizes MRT declarations by slot and rejects sparse slots', () => {
    const graph = new RenderGraphBuilder();
    const first = graph.createTexture(colorTexture());
    const second = graph.createTexture(colorTexture());
    graph.addRasterPass({
      id: 'reversed-mrt',
      setup(pass) {
        pass.colorAttachment(1, second, { load: 'clear', store: 'store' });
        pass.colorAttachment(0, first, { load: 'clear', store: 'store' });
        pass.sideEffect('inspect canonical slots');
        return {};
      },
      run() {}
    });
    expect(graph.build().passes[0]?.rasterDetails?.colorAttachments.map(({ slot }) => slot)).toEqual([
      0, 1
    ]);

    const sparseGraph = new RenderGraphBuilder();
    const sparse = sparseGraph.createTexture(colorTexture());
    expect(() =>
      sparseGraph.addRasterPass({
        id: 'sparse-mrt',
        setup(pass) {
          pass.colorAttachment(1, sparse, { load: 'clear', store: 'store' });
          return {};
        },
        run() {}
      })
    ).toThrow(/contiguous.*slot 0/i);
  });

  test('accepts only compatible multisample color resolves', () => {
    const graph = new RenderGraphBuilder();
    const multisampled = graph.createTexture(colorTexture(4));
    const destination = graph.createTexture(colorTexture());
    expect(() =>
      graph.addRasterPass({
        id: 'valid-resolve',
        setup(pass) {
          const source = pass.colorAttachment(0, multisampled, {
            load: 'clear',
            store: 'discard'
          });
          pass.resolveAttachment?.(0, source, destination);
          pass.sideEffect('resolve');
          return {};
        },
        run() {}
      })
    ).not.toThrow();

    const invalidGraph = new RenderGraphBuilder();
    const singleSampleSource = invalidGraph.createTexture(colorTexture());
    const singleSampleDestination = invalidGraph.createTexture(colorTexture());
    expect(() =>
      invalidGraph.addRasterPass({
        id: 'invalid-resolve',
        setup(pass) {
          const source = pass.colorAttachment(0, singleSampleSource, {
            load: 'clear',
            store: 'discard'
          });
          pass.resolveAttachment?.(0, source, singleSampleDestination);
          return {};
        },
        run() {}
      })
    ).toThrow(/multisampled source.*single-sampled destination/i);
  });
});

import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  RenderGraphCycleError,
  RenderGraphSemanticHazardError,
  compileRenderGraph
} from '../../src/render-graph/compiler';
import type { TextureDescriptor } from '../../src/render-graph/types';

const descriptor: TextureDescriptor = {
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment', 'copy-src']
};

function importedGraphTexture(graph: RenderGraphBuilder, id: string) {
  return graph.createTexture(descriptor, {
    origin: {
      kind: 'imported' as const,
      initialState: 'sampled' as const,
      acquire: { kind: 'external-acquire' as const, id }
    }
  });
}

describe('render graph compiler', () => {
  test('uses registration order as the stable tie-breaker', () => {
    const graph = new RenderGraphBuilder();
    for (const id of ['third-party/z', 'builtin/a', 'feature/m']) {
      graph.addCopyPass({
        id,
        setup(pass) {
          pass.sideEffect(`observable ${id}`);
          return {};
        },
        run() {}
      });
    }

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.order).toEqual([0, 1, 2]);
    expect(compiled.retainedPasses.map((pass) => pass.id)).toEqual([
      'third-party/z',
      'builtin/a',
      'feature/m'
    ]);
  });

  test('accepts a semantic edge in the same direction as a required hazard', () => {
    const graph = new RenderGraphBuilder();
    const initial = importedGraphTexture(graph, 'same-direction');
    let written = initial;
    const writer = graph.addRasterPass({
      id: 'writer',
      setup(pass) {
        written = pass.colorAttachment(0, initial, { load: 'clear', store: 'store' });
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'reader',
      setup(pass) {
        pass.after(writer);
        pass.readTexture(written, 'sampled');
        pass.sideEffect('consume');
        return {};
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.order).toEqual([0, 1]);
    expect(compiled.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'raw', fromPassId: 0, toPassId: 1 }),
        expect.objectContaining({ kind: 'semantic', fromPassId: 0, toPassId: 1 })
      ])
    );
  });

  test('keeps an explicitly declared same-pass read-old/write-new operation inside the pass', () => {
    const graph = new RenderGraphBuilder();
    const initial = importedGraphTexture(graph, 'same-pass-old-and-new');

    graph.addRasterPass({
      id: 'in-place-logical-version',
      setup(pass) {
        pass.readTexture(initial, 'sampled');
        const written = pass.colorAttachment(0, initial, { load: 'clear', store: 'store' });
        pass.exportResource(written, 'copy-src');
        return { initial, written };
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.order).toEqual([0]);
    expect(compiled.edges).not.toContainEqual(
      expect.objectContaining({ fromPassId: 0, toPassId: 0 })
    );
  });

  test('rejects a semantic edge that reverses a required hazard path', () => {
    const graph = new RenderGraphBuilder();
    const initial = importedGraphTexture(graph, 'reversed-edge');
    let written = initial;
    const writer = graph.addRasterPass({
      id: 'writer',
      setup(pass) {
        written = pass.colorAttachment(0, initial, { load: 'clear', store: 'store' });
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-parent',
      setup(pass) {
        pass.after(writer);
        pass.readTexture(initial, 'sampled');
        pass.sideEffect('old-content consumer');
        return {};
      },
      run() {}
    });

    const snapshot = graph.build();
    expect(() => compileRenderGraph(snapshot)).toThrow(RenderGraphSemanticHazardError);
    expect(() => compileRenderGraph(snapshot)).toThrow(/writer.*read-parent|read-parent.*writer/i);
  });

  test('reports the shortest readable typed cycle', () => {
    const graph = new RenderGraphBuilder();
    const initial = importedGraphTexture(graph, 'cycle');
    let written = initial;

    graph.addRasterPass({
      id: 'write-new',
      setup(pass) {
        written = pass.colorAttachment(0, initial, { load: 'clear', store: 'store' });
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-old-and-new',
      setup(pass) {
        pass.readTexture(initial, 'sampled');
        pass.readTexture(written, 'sampled');
        pass.sideEffect('forces the cycle into the retained graph');
        return {};
      },
      run() {}
    });

    let thrown: unknown;
    try {
      compileRenderGraph(graph.build());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RenderGraphCycleError);
    const cycle = thrown as RenderGraphCycleError;
    expect(cycle.passChain).toEqual(['write-new', 'read-old-and-new', 'write-new']);
    expect(cycle.edges.map((edge) => edge.kind)).toEqual(['raw', 'war']);
    expect(cycle.message).toMatch(/write-new.*RAW.*read-old-and-new.*WAR.*write-new/i);
  });

  test('rejects a snapshot with incompatible passKind and write usage', () => {
    const graph = new RenderGraphBuilder();
    const initial = importedGraphTexture(graph, 'forged-check');
    graph.addCopyPass({
      id: 'valid-copy',
      setup(pass) {
        pass.readTexture(initial, 'copy-src');
        return {};
      },
      run() {}
    });
    const snapshot = graph.build();
    const forgedSnapshot = {
      ...snapshot,
      passes: [
        {
          ...snapshot.passes[0]!,
          accesses: [
            ...snapshot.passes[0]!.accesses,
            {
              kind: 'write' as const,
              handle: initial,
              usage: 'color-attachment' as any,
              range: {
                baseMipLevel: 0,
                mipLevelCount: 1,
                baseArrayLayer: 0,
                arrayLayerCount: 1,
                aspect: 'all' as const
              }
            }
          ]
        }
      ]
    };
    expect(() => compileRenderGraph(forgedSnapshot as any)).toThrow(
      /Copy pass.*cannot declare write usage "color-attachment"/i
    );
  });
});

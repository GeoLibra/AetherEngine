import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import type { TextureDescriptor } from '../../src/render-graph/types';

const descriptor: TextureDescriptor = {
  width: 8,
  height: 8,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment', 'copy-src']
};

describe('render graph culling', () => {
  test('uses only the authoritative active export terminal as the terminal root', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createTexture(descriptor);
    let first = initial;

    graph.addCopyPass({
      id: 'stale-export-author',
      setup(pass) {
        first = pass.writeTexture(initial, 'color-attachment');
        pass.exportResource(first, 'copy-src');
        return { first };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'active-export-author',
      setup(pass) {
        const final = pass.writeTexture(first, 'color-attachment');
        pass.exportResource(final, 'copy-src');
        return { final };
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.rootPassIds).toEqual([1]);
    expect(compiled.order).toEqual([0, 1]);
  });

  test('retains present and explicit side-effect roots', () => {
    const graph = new RenderGraphBuilder();
    const surface = graph.createTexture(descriptor, {
      origin: {
        kind: 'imported',
        initialState: 'color-attachment',
        acquire: { kind: 'external-acquire', id: 'frame-1' }
      }
    });

    graph.addCopyPass({
      id: 'telemetry',
      setup(pass) {
        pass.sideEffect('timestamp resolve');
        return {};
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'present',
      setup(pass) {
        const output = pass.writeTexture(surface, 'color-attachment');
        pass.present(output, { kind: 'surface-frame', id: 'frame-1' });
        return { output };
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.rootPassIds).toEqual([0, 1]);
    expect(compiled.culledPasses).toEqual([]);
  });

  test('does not treat imported reads or writes as observable roots', () => {
    const graph = new RenderGraphBuilder();
    const imported = graph.createTexture(descriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'external-input' }
      }
    });
    let written = imported;

    graph.addCopyPass({
      id: 'read-imported',
      setup(pass) {
        return { imported: pass.readTexture(imported, 'sampled') };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'write-imported',
      setup(pass) {
        written = pass.writeTexture(imported, 'color-attachment');
        return { written };
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.rootPassIds).toEqual([]);
    expect(compiled.order).toEqual([]);
    expect(compiled.culledPasses.map((pass) => pass.id)).toEqual([
      'read-imported',
      'write-imported'
    ]);
  });

  test('retains only the predecessor closure of roots and culls unused branches transitively', () => {
    const graph = new RenderGraphBuilder();
    const retainedTexture = graph.createTexture(descriptor);
    const unusedTexture = graph.createTexture(descriptor);
    let retained = retainedTexture;
    let unused = unusedTexture;

    graph.addCopyPass({
      id: 'retained-producer',
      setup(pass) {
        retained = pass.writeTexture(retainedTexture, 'color-attachment');
        return { retained };
      },
      run() {}
    });
    const root = graph.addCopyPass({
      id: 'retained-consumer',
      setup(pass) {
        pass.readTexture(retained, 'sampled');
        pass.sideEffect('external callback');
        return {};
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'unused-producer',
      setup(pass) {
        unused = pass.writeTexture(unusedTexture, 'color-attachment');
        return { unused };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'unused-consumer',
      setup(pass) {
        return { unused: pass.readTexture(unused, 'sampled') };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'downstream-of-root',
      setup(pass) {
        pass.after(root);
        return {};
      },
      run() {}
    });

    const compiled = compileRenderGraph(graph.build());

    expect(compiled.order).toEqual([0, 1]);
    expect(compiled.culledPasses).toEqual([
      expect.objectContaining({ id: 'unused-producer', reason: 'unreachable-from-root' }),
      expect.objectContaining({ id: 'unused-consumer', reason: 'unreachable-from-root' }),
      expect.objectContaining({ id: 'downstream-of-root', reason: 'unreachable-from-root' })
    ]);
  });
});

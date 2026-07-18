import { describe, expect, test } from 'vitest';
import {
  RenderGraphBuilder,
  type GraphAccess,
  type RenderGraphSnapshot
} from '../../src/render-graph/builder';
import { deriveRenderGraphHazards } from '../../src/render-graph/hazards';
import type {
  BufferDescriptor,
  BufferRange,
  TextureDescriptor,
  TextureRange
} from '../../src/render-graph/types';

const textureDescriptor: TextureDescriptor = {
  width: 32,
  height: 32,
  depthOrArrayLayers: 1,
  mipLevelCount: 2,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment', 'copy-src']
};

const bufferDescriptor: BufferDescriptor = {
  size: 64,
  usage: ['storage-read', 'storage-write', 'copy-src']
};

function mip(baseMipLevel: number): TextureRange {
  return {
    baseMipLevel,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
    aspect: 'all'
  };
}

function bytes(offset: number, size: number): BufferRange {
  return { offset, size };
}

describe('render graph hazards', () => {
  test('derives overlapping texture RAW, WAR, and WAW edges from version lineage', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'hazard-texture' }
      }
    });
    let first = initial;

    graph.addPass({
      id: 'write-first',
      setup(pass) {
        first = pass.writeTexture(initial, 'color-attachment', mip(0));
        return { first };
      },
      run() {}
    });
    graph.addPass({
      id: 'read-first',
      setup(pass) {
        return { first: pass.readTexture(first, 'sampled', mip(0)) };
      },
      run() {}
    });
    graph.addPass({
      id: 'read-parent',
      setup(pass) {
        return { initial: pass.readTexture(initial, 'sampled', mip(0)) };
      },
      run() {}
    });
    graph.addPass({
      id: 'write-second',
      setup(pass) {
        const second = pass.writeTexture(first, 'color-attachment', mip(0));
        pass.exportTexture(second, 'copy-src');
        return { second };
      },
      run() {}
    });

    const result = deriveRenderGraphHazards(graph.build());

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'raw', fromPassId: 0, toPassId: 1, version: 1 }),
        expect.objectContaining({ kind: 'war', fromPassId: 2, toPassId: 0, version: 1 }),
        expect.objectContaining({ kind: 'war', fromPassId: 1, toPassId: 3, version: 2 }),
        expect.objectContaining({ kind: 'waw', fromPassId: 0, toPassId: 3, version: 2 })
      ])
    );
    expect(result.edges.every((edge) => edge.range.kind === 'texture')).toBe(true);
    expect(result.counters.wholeResourceFallbacks).toBe(0);
  });

  test('derives overlapping buffer RAW edges', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createBuffer(bufferDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'storage-read',
        acquire: { kind: 'external-acquire', id: 'hazard-buffer' }
      }
    });
    let written = initial;

    graph.addPass({
      id: 'write-buffer',
      setup(pass) {
        written = pass.writeBuffer(initial, 'storage-write', bytes(8, 16));
        return { written };
      },
      run() {}
    });
    graph.addPass({
      id: 'read-buffer',
      setup(pass) {
        pass.readBuffer(written, 'storage-read', bytes(12, 4));
        pass.sideEffect('readback');
        return {};
      },
      run() {}
    });

    expect(deriveRenderGraphHazards(graph.build()).edges).toContainEqual(
      expect.objectContaining({
        kind: 'raw',
        fromPassId: 0,
        toPassId: 1,
        resourceId: 0,
        version: 1,
        range: expect.objectContaining({ kind: 'buffer', offset: 12, size: 4 }),
        fallback: false
      })
    );
  });

  test('does not add false hazards for proven disjoint buffer ranges', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createBuffer(bufferDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'storage-read',
        acquire: { kind: 'external-acquire', id: 'disjoint-buffer' }
      }
    });
    let first = initial;

    graph.addPass({
      id: 'write-low',
      setup(pass) {
        first = pass.writeBuffer(initial, 'storage-write', bytes(0, 16));
        return { first };
      },
      run() {}
    });
    graph.addPass({
      id: 'read-high-parent',
      setup(pass) {
        return { initial: pass.readBuffer(initial, 'storage-read', bytes(32, 16)) };
      },
      run() {}
    });
    graph.addPass({
      id: 'write-high',
      setup(pass) {
        const second = pass.writeBuffer(first, 'storage-write', bytes(32, 16));
        pass.exportBuffer(second, 'copy-src');
        return { second };
      },
      run() {}
    });

    const edges = deriveRenderGraphHazards(graph.build()).edges;

    expect(edges).not.toContainEqual(expect.objectContaining({ fromPassId: 0, toPassId: 1 }));
    expect(edges).not.toContainEqual(expect.objectContaining({ fromPassId: 1, toPassId: 0 }));
    expect(edges).not.toContainEqual(
      expect.objectContaining({ kind: 'waw', fromPassId: 0, toPassId: 2 })
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: 'war', fromPassId: 1, toPassId: 2 })
    );
  });

  test('falls back to the whole resource and counts an unknown range', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createBuffer(bufferDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'storage-read',
        acquire: { kind: 'external-acquire', id: 'unknown-range' }
      }
    });
    let written = initial;

    graph.addPass({
      id: 'write',
      setup(pass) {
        written = pass.writeBuffer(initial, 'storage-write', bytes(0, 16));
        return { written };
      },
      run() {}
    });
    graph.addPass({
      id: 'unknown-read',
      setup(pass) {
        pass.readBuffer(written, 'storage-read', bytes(0, 8));
        pass.sideEffect('unknown external footprint');
        return {};
      },
      run() {}
    });

    const snapshot = graph.build();
    const unknownAccess = Object.freeze({
      ...snapshot.passes[1]!.accesses[0]!,
      range: undefined
    }) as unknown as GraphAccess;
    const unknownSnapshot = Object.freeze({
      ...snapshot,
      passes: Object.freeze([
        snapshot.passes[0]!,
        Object.freeze({
          ...snapshot.passes[1]!,
          accesses: Object.freeze([unknownAccess])
        })
      ])
    }) as RenderGraphSnapshot;

    const result = deriveRenderGraphHazards(unknownSnapshot);

    expect(result.edges).toContainEqual(
      expect.objectContaining({
        kind: 'raw',
        fromPassId: 0,
        toPassId: 1,
        fallback: true,
        range: expect.objectContaining({ kind: 'buffer', offset: 0, size: 64 })
      })
    );
    expect(result.counters.wholeResourceFallbacks).toBeGreaterThan(0);
  });
});

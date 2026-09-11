import { describe, expect, test } from 'vitest';
import {
  RenderGraphBuilder,
  type GraphAccess,
  type RenderGraphSnapshot
} from '../../src/render-graph/builder';
import {
  deriveRenderGraphHazards,
  fullBufferRange,
  fullTextureRange
} from '../../src/render-graph/compiler';
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

function replaceAccessRange(
  snapshot: RenderGraphSnapshot,
  passId: number,
  accessIndex: number,
  range: unknown
): RenderGraphSnapshot {
  const pass = snapshot.passes[passId]!;
  const accesses = [...pass.accesses];
  accesses[accessIndex] = Object.freeze({
    ...accesses[accessIndex]!,
    range
  }) as unknown as GraphAccess;
  const passes = [...snapshot.passes];
  passes[passId] = Object.freeze({ ...pass, accesses: Object.freeze(accesses) });
  return Object.freeze({ ...snapshot, passes: Object.freeze(passes) });
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

    graph.addCopyPass({
      id: 'write-first',
      setup(pass) {
        first = pass.writeTexture(initial, 'color-attachment', mip(0));
        return { first };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-first',
      setup(pass) {
        return { first: pass.readTexture(first, 'sampled', mip(0)) };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-parent',
      setup(pass) {
        return { initial: pass.readTexture(initial, 'sampled', mip(0)) };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'write-second',
      setup(pass) {
        const second = pass.writeTexture(first, 'color-attachment', mip(0));
        pass.exportResource(second, 'copy-src');
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

    graph.addCopyPass({
      id: 'write-buffer',
      setup(pass) {
        written = pass.writeBuffer(initial, 'storage-write', bytes(8, 16));
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
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

    graph.addCopyPass({
      id: 'write-low',
      setup(pass) {
        first = pass.writeBuffer(initial, 'storage-write', bytes(0, 16));
        return { first };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-high-parent',
      setup(pass) {
        return { initial: pass.readBuffer(initial, 'storage-read', bytes(32, 16)) };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'write-high',
      setup(pass) {
        const second = pass.writeBuffer(first, 'storage-write', bytes(32, 16));
        pass.exportResource(second, 'copy-src');
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

    graph.addCopyPass({
      id: 'write',
      setup(pass) {
        written = pass.writeBuffer(initial, 'storage-write', bytes(0, 16));
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
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

  test.each([
    ['out-of-bounds mip', { baseMipLevel: 2, mipLevelEnd: 3 }],
    ['out-of-bounds layer', { baseArrayLayer: 1, arrayLayerEnd: 2 }],
    ['invalid aspect', { aspect: 'plane-7' }]
  ])('uses conservative RAW for a numeric-shaped texture range with %s', (_, damage) => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'damaged-texture-read' }
      }
    });
    let written = initial;
    graph.addCopyPass({
      id: 'texture-writer',
      setup(pass) {
        written = pass.writeTexture(initial, 'color-attachment', mip(0));
        return { written };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'texture-reader',
      setup(pass) {
        pass.readTexture(written, 'sampled', mip(0));
        pass.sideEffect('read result');
        return {};
      },
      run() {}
    });
    const snapshot = graph.build();
    const validRange = snapshot.passes[1]!.accesses[0]!.range;
    const damaged = replaceAccessRange(snapshot, 1, 0, Object.freeze({ ...validRange, ...damage }));
    const result = deriveRenderGraphHazards(damaged);
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        kind: 'raw',
        fromPassId: 0,
        toPassId: 1,
        fallback: true,
        range: fullTextureRange(textureDescriptor)
      })
    );
    expect(result.counters.wholeResourceFallbacks).toBeGreaterThan(0);
  });

  test('uses conservative WAW for an invalid numeric-shaped texture write range', () => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'damaged-texture-write' }
      }
    });
    let first = initial;
    graph.addCopyPass({
      id: 'write-mip-zero',
      setup(pass) {
        first = pass.writeTexture(initial, 'color-attachment', mip(0));
        return { first };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'write-mip-one',
      setup(pass) {
        const second = pass.writeTexture(first, 'color-attachment', mip(1));
        pass.exportResource(second, 'copy-src');
        return { second };
      },
      run() {}
    });
    const snapshot = graph.build();
    const validRange = snapshot.passes[1]!.accesses[0]!.range;
    const damaged = replaceAccessRange(
      snapshot,
      1,
      0,
      Object.freeze({ ...validRange, aspect: 'plane-7' })
    );
    const result = deriveRenderGraphHazards(damaged);
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        kind: 'waw',
        fromPassId: 0,
        toPassId: 1,
        fallback: true,
        range: fullTextureRange(textureDescriptor)
      })
    );
    expect(result.counters.wholeResourceFallbacks).toBeGreaterThan(0);
  });

  test.each([
    ['out-of-bounds', { kind: 'buffer', offset: 60, size: 16, end: 76 }],
    ['inconsistent derived end', { kind: 'buffer', offset: 32, size: 16, end: 33 }]
  ])('uses conservative WAR for a %s numeric-shaped buffer range', (_, damagedRange) => {
    const graph = new RenderGraphBuilder();
    const initial = graph.createBuffer(bufferDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'storage-read',
        acquire: { kind: 'external-acquire', id: 'damaged-buffer-read' }
      }
    });
    graph.addCopyPass({
      id: 'write-low-buffer',
      setup(pass) {
        return { written: pass.writeBuffer(initial, 'storage-write', bytes(0, 16)) };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'read-old-buffer',
      setup(pass) {
        return { initial: pass.readBuffer(initial, 'storage-read', bytes(32, 16)) };
      },
      run() {}
    });
    const damaged = replaceAccessRange(graph.build(), 1, 0, Object.freeze(damagedRange));
    const result = deriveRenderGraphHazards(damaged);
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        kind: 'war',
        fromPassId: 1,
        toPassId: 0,
        fallback: true,
        range: fullBufferRange(bufferDescriptor)
      })
    );
    expect(result.counters.wholeResourceFallbacks).toBeGreaterThan(0);
  });
});

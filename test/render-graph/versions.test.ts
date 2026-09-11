import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import type { CopyPassBuilder } from '../../src/render-graph/types';
import type { TextureDescriptor, TextureRange } from '../../src/render-graph/types';

const textureDescriptor: TextureDescriptor = {
  label: 'versioned-color',
  width: 64,
  height: 64,
  depthOrArrayLayers: 1,
  mipLevelCount: 4,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment', 'copy-src']
};

function mipRange(baseMipLevel: number, mipLevelCount = 1): TextureRange {
  return {
    baseMipLevel,
    mipLevelCount,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
    aspect: 'all'
  };
}

describe('render graph resource versions', () => {
  test('rejects one-slot history origins because previous and next content must be distinct', () => {
    const graph = new RenderGraphBuilder();

    expect(() =>
      graph.createTexture(textureDescriptor, {
        origin: { kind: 'history', key: 'taa/color', slots: 1 }
      })
    ).toThrow(/at least two/i);
  });
  test('whole writes create immutable initialized child versions', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    let written = texture;

    graph.addRasterPass({
      id: 'write-whole',
      setup(pass) {
        written = pass.colorAttachment(0, texture, { load: 'clear', store: 'store' });
        return { written };
      },
      run() {}
    });

    const snapshot = graph.build();
    const resource = snapshot.resources[0];

    expect(written.version).toBe(1);
    expect(resource?.versions).toHaveLength(2);
    expect(resource?.versions[1]).toMatchObject({ version: 1, parentVersion: 0 });
    expect(resource?.versions[1]?.initialized).toHaveLength(1);
    expect(Object.isFrozen(resource?.versions[1]?.initialized)).toBe(true);
  });

  test('partial child writes inherit non-overlapping initialized parent ranges', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    let first = texture;
    let second = texture;

    graph.addRasterPass({
      id: 'write-mip-zero',
      setup(pass) {
        first = pass.colorAttachment(0, texture, {
          range: mipRange(0),
          load: 'clear',
          store: 'store'
        });
        return { first };
      },
      run() {}
    });
    graph.addRasterPass({
      id: 'write-mip-one',
      setup(pass) {
        second = pass.colorAttachment(0, first, {
          range: mipRange(1),
          load: 'clear',
          store: 'store'
        });
        return { second };
      },
      run() {}
    });

    graph.addCopyPass({
      id: 'read-inherited-mips',
      setup(pass) {
        pass.readTexture(second, 'sampled', mipRange(0, 2));
        return {};
      },
      run() {}
    });

    const version = graph.build().resources[0]?.versions[2];
    expect(version?.parentVersion).toBe(1);
    expect(version?.initialized).toEqual([
      expect.objectContaining({
        sourceVersion: 1,
        range: expect.objectContaining({ baseMipLevel: 0 })
      }),
      expect.objectContaining({
        sourceVersion: 2,
        range: expect.objectContaining({ baseMipLevel: 1 })
      })
    ]);
  });

  test('rejects implicit sibling versions instead of merging them', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    graph.addRasterPass({
      id: 'first-child',
      setup(pass) {
        return {
          first: pass.colorAttachment(0, texture, {
            range: mipRange(0),
            load: 'clear',
            store: 'store'
          })
        };
      },
      run() {}
    });

    expect(() =>
      graph.addRasterPass({
        id: 'forbidden-sibling',
        setup(pass) {
          return {
            second: pass.colorAttachment(0, texture, {
              range: mipRange(1),
              load: 'clear',
              store: 'store'
            })
          };
        },
        run() {}
      })
    ).toThrow(/sibling|latest version/i);
  });

  test('rejects reads containing any uninitialized range', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    let partial = texture;

    graph.addRasterPass({
      id: 'partial-write',
      setup(pass) {
        partial = pass.colorAttachment(0, texture, {
          range: mipRange(0),
          load: 'clear',
          store: 'store'
        });
        return { partial };
      },
      run() {}
    });

    expect(() =>
      graph.addCopyPass({
        id: 'uninitialized-read',
        setup(pass) {
          return { texture: pass.readTexture(partial, 'sampled', mipRange(0, 2)) };
        },
        run() {}
      })
    ).toThrow(/uninitialized/i);
  });

  test('treats imported contents and only valid history contents as initialized', () => {
    const graph = new RenderGraphBuilder();
    const imported = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'camera-color' }
      }
    });
    const validHistory = graph.createTexture(textureDescriptor, {
      origin: { kind: 'history', key: 'taa/color', slots: 2 },
      historyValid: true
    });
    const invalidHistory = graph.createTexture(textureDescriptor, {
      origin: { kind: 'history', key: 'taa/depth', slots: 2 },
      historyValid: false
    });

    graph.addCopyPass({
      id: 'read-external-state',
      setup(pass) {
        pass.readTexture(imported, 'sampled');
        pass.readTexture(validHistory, 'sampled');
        return {};
      },
      run() {}
    });

    expect(() =>
      graph.addCopyPass({
        id: 'read-invalid-history',
        setup(pass) {
          return { invalidHistory: pass.readTexture(invalidHistory, 'sampled') };
        },
        run() {}
      })
    ).toThrow(/uninitialized/i);
  });

  test('a depth-only child write inherits initialized stencil contents', () => {
    const graph = new RenderGraphBuilder();
    const depthStencil = graph.createTexture(
      { ...textureDescriptor, format: 'depth24plus-stencil8', usage: ['sampled', 'copy-dst'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: 'depth-stencil' }
        }
      }
    );
    let depthWritten = depthStencil;

    graph.addCopyPass({
      id: 'write-depth',
      setup(pass) {
        depthWritten = pass.writeTexture(depthStencil, 'copy-dst', {
          ...mipRange(0, 4),
          aspect: 'depth-only'
        });
        return { depthWritten };
      },
      run() {}
    });

    expect(() =>
      graph.addCopyPass({
        id: 'read-inherited-stencil',
        setup(pass) {
          return {
            stencil: pass.readTexture(depthWritten, 'sampled', {
              ...mipRange(0, 4),
              aspect: 'stencil-only'
            })
          };
        },
        run() {}
      })
    ).not.toThrow();
  });

  test('validates imported initial state against the resource kind', () => {
    const graph = new RenderGraphBuilder();

    expect(() =>
      graph.createTexture(textureDescriptor, {
        origin: {
          kind: 'imported',
          initialState: 'vertex',
          acquire: { kind: 'external-acquire', id: 'wrong-state' }
        }
      })
    ).toThrow(/texture.*initial state/i);
  });

  test('rejects a leaked rolled-back handle after its resource id is reused', () => {
    const graph = new RenderGraphBuilder();
    let leaked: ReturnType<CopyPassBuilder['createTexture']> | undefined;

    expect(() =>
      graph.addCopyPass({
        id: 'leak-then-fail',
        setup(pass) {
          leaked = pass.createTexture(textureDescriptor, {
            origin: {
              kind: 'imported',
              initialState: 'sampled',
              acquire: { kind: 'external-acquire', id: 'rolled-back' }
            }
          });
          throw new Error('rollback');
        },
        run() {}
      })
    ).toThrow(/rollback/i);

    const replacement = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'replacement' }
      }
    });
    expect(leaked).toMatchObject({ resourceId: replacement.resourceId, version: 0 });
    expect(leaked).not.toBe(replacement);

    expect(() =>
      graph.addCopyPass({
        id: 'read-leaked-handle',
        setup(pass) {
          return { leaked: pass.readTexture(leaked as typeof replacement, 'sampled') };
        },
        run() {}
      })
    ).toThrow(/handle.*current|unknown.*handle/i);
  });
});

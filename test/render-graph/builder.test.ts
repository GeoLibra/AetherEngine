import { describe, expect, test, vi } from 'vitest';
import { RenderGraphBuilder, type PassBuilder } from '../../src/render-graph/builder';
import type { BufferDescriptor, TextureDescriptor } from '../../src/render-graph/types';

const textureDescriptor: TextureDescriptor = {
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['color-attachment', 'copy-src']
};

const bufferDescriptor: BufferDescriptor = {
  size: 32,
  usage: ['copy-dst', 'copy-src']
};

describe('render graph pass declarations', () => {
  test('stores setup declarations without executing the run callback', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    const run = vi.fn();

    const token = graph.addPass({
      id: 'opaque',
      setup(pass) {
        return { color: pass.writeTexture(texture, 'color-attachment') };
      },
      run
    });

    const snapshot = graph.build();
    expect(run).not.toHaveBeenCalled();
    expect(snapshot.passes[0]).toMatchObject({ id: 'opaque', token });
    expect(snapshot.passes[0]?.accesses).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.passes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.passes[0]?.accesses)).toBe(true);
    expect(Object.isFrozen(snapshot.passes[0]?.resources)).toBe(true);
  });

  test('records explicit side effects and semantic after edges', () => {
    const graph = new RenderGraphBuilder();
    const first = graph.addPass({
      id: 'upload',
      setup(pass) {
        pass.sideEffect('external upload callback');
        return {};
      },
      run() {}
    });
    graph.addPass({
      id: 'consume',
      setup(pass) {
        pass.after(first);
        return {};
      },
      run() {}
    });

    const snapshot = graph.build();
    expect(snapshot.passes[0]?.sideEffects).toEqual(['external upload callback']);
    expect(snapshot.semanticEdges).toEqual([
      expect.objectContaining({ fromPassId: first.passId, toPassId: 1 })
    ]);
  });

  test('enforces one terminal operation on the exact final logical version', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    let exported = texture;

    graph.addPass({
      id: 'export-old-version',
      setup(pass) {
        exported = pass.writeTexture(texture, 'color-attachment');
        pass.exportTexture(exported, 'copy-src');
        return { exported };
      },
      run() {}
    });
    graph.addPass({
      id: 'write-after-export',
      setup(pass) {
        return { newer: pass.writeTexture(exported, 'color-attachment') };
      },
      run() {}
    });

    expect(() => graph.build()).toThrow(/terminal.*final|final.*version/i);
  });

  test('rejects duplicate terminals for one logical resource', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addPass({
        id: 'duplicate-export',
        setup(pass) {
          const output = pass.writeTexture(texture, 'color-attachment');
          pass.exportTexture(output, 'copy-src');
          pass.exportTexture(output, 'copy-src');
          return { output };
        },
        run() {}
      })
    ).toThrow(/terminal/i);
  });

  test('redeclaring a terminal on a newer version replaces the stale terminal', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    let first = texture;

    graph.addPass({
      id: 'first-export',
      setup(pass) {
        first = pass.writeTexture(texture, 'color-attachment');
        pass.exportTexture(first, 'copy-src');
        return { first };
      },
      run() {}
    });
    graph.addPass({
      id: 'final-export',
      setup(pass) {
        const final = pass.writeTexture(first, 'color-attachment');
        pass.exportTexture(final, 'copy-src');
        return { final };
      },
      run() {}
    });

    const snapshot = graph.build();
    expect(snapshot.terminals).toHaveLength(1);
    expect(snapshot.terminals[0]?.handle.version).toBe(2);
  });

  test('rejects a terminal whose final content is uninitialized', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addPass({
        id: 'export-uninitialized',
        setup(pass) {
          pass.exportTexture(texture, 'copy-src');
          return { texture };
        },
        run() {}
      })
    ).toThrow(/uninitialized/i);
  });

  test('rejects declaration mutation after setup and after build begins', () => {
    const graph = new RenderGraphBuilder();
    const buffer = graph.createBuffer(bufferDescriptor);
    let escapedPass: PassBuilder | undefined;

    graph.addPass({
      id: 'write-buffer',
      setup(pass) {
        escapedPass = pass;
        return { buffer: pass.writeBuffer(buffer, 'copy-dst') };
      },
      run() {}
    });

    expect(() => escapedPass?.sideEffect('late mutation')).toThrow(/setup.*complete|frozen/i);
    graph.build();
    expect(() => graph.createTexture(textureDescriptor)).toThrow(/build/i);
    expect(() => graph.addPass({ id: 'too-late', setup: () => ({}), run() {} })).toThrow(/build/i);
  });

  test('only accepts declared descriptor usages', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addPass({
        id: 'invalid-usage',
        setup(pass) {
          return { texture: pass.writeTexture(texture, 'storage-write') };
        },
        run() {}
      })
    ).toThrow(/usage/i);
  });

  test('rejects a write usage passed through a read declaration at runtime', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'color-attachment',
        acquire: { kind: 'external-acquire', id: 'unsafe-read' }
      }
    });

    expect(() =>
      graph.addPass({
        id: 'wrong-access-mode',
        setup(pass) {
          const unsafe = pass as unknown as {
            readTexture(handle: typeof texture, usage: string): typeof texture;
          };
          return { texture: unsafe.readTexture(texture, 'color-attachment') };
        },
        run() {}
      })
    ).toThrow(/read usage/i);
  });

  test('rolls back declarations when setup fails', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addPass({
        id: 'failed-setup',
        setup(pass) {
          const output = pass.writeTexture(texture, 'color-attachment');
          pass.exportTexture(output, 'copy-src');
          throw new Error('setup failed');
        },
        run() {}
      })
    ).toThrow(/setup failed/i);

    graph.addPass({
      id: 'replacement',
      setup(pass) {
        const output = pass.writeTexture(texture, 'color-attachment');
        pass.exportTexture(output, 'copy-src');
        return { output };
      },
      run() {}
    });

    expect(graph.build().resources[0]?.currentVersion).toBe(1);
  });
});

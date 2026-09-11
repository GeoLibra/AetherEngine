import { describe, expect, test, vi } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import type { CopyPassBuilder } from '../../src/render-graph/types';
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
  test('requires present to target the matching imported surface acquire', () => {
    const transientGraph = new RenderGraphBuilder();
    const transient = transientGraph.createTexture(textureDescriptor);
    expect(() =>
      transientGraph.addCopyPass({
        id: 'invalid-present',
        setup(pass) {
          const output = pass.writeTexture(transient, 'color-attachment');
          pass.present(output, { kind: 'surface-frame', id: 'main' });
          return output;
        },
        run() {}
      })
    ).toThrow(/present.*imported/i);

    const importedGraph = new RenderGraphBuilder();
    const imported = importedGraph.createTexture(textureDescriptor, {
      origin: {
        kind: 'imported',
        initialState: 'undefined',
        acquire: { kind: 'external-acquire', id: 'main' }
      }
    });
    expect(() =>
      importedGraph.addCopyPass({
        id: 'mismatched-present',
        setup(pass) {
          const output = pass.writeTexture(imported, 'color-attachment');
          pass.present(output, { kind: 'surface-frame', id: 'other' });
          return output;
        },
        run() {}
      })
    ).toThrow(/frame token.*acquire token/i);
  });
  test('stores setup declarations without executing the run callback', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);
    const run = vi.fn();

    const token = graph.addCopyPass({
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
    const first = graph.addCopyPass({
      id: 'upload',
      setup(pass) {
        pass.sideEffect('external upload callback');
        return {};
      },
      run() {}
    });
    graph.addCopyPass({
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

    graph.addCopyPass({
      id: 'export-old-version',
      setup(pass) {
        exported = pass.writeTexture(texture, 'color-attachment');
        pass.exportResource(exported, 'copy-src');
        return { exported };
      },
      run() {}
    });
    graph.addCopyPass({
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
      graph.addCopyPass({
        id: 'duplicate-export',
        setup(pass) {
          const output = pass.writeTexture(texture, 'color-attachment');
          pass.exportResource(output, 'copy-src');
          pass.exportResource(output, 'copy-src');
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

    graph.addCopyPass({
      id: 'first-export',
      setup(pass) {
        first = pass.writeTexture(texture, 'color-attachment');
        pass.exportResource(first, 'copy-src');
        return { first };
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'final-export',
      setup(pass) {
        const final = pass.writeTexture(first, 'color-attachment');
        pass.exportResource(final, 'copy-src');
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
      graph.addCopyPass({
        id: 'export-uninitialized',
        setup(pass) {
          pass.exportResource(texture, 'copy-src');
          return { texture };
        },
        run() {}
      })
    ).toThrow(/uninitialized/i);
  });

  test('rejects declaration mutation after setup and after build begins', () => {
    const graph = new RenderGraphBuilder();
    const buffer = graph.createBuffer(bufferDescriptor);
    let escapedPass: CopyPassBuilder | undefined;

    graph.addCopyPass({
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
    expect(() => graph.addCopyPass({ id: 'too-late', setup: () => ({}), run() {} })).toThrow(
      /build/i
    );
  });

  test('only accepts declared descriptor usages', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addCopyPass({
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
      graph.addCopyPass({
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
      graph.addCopyPass({
        id: 'failed-setup',
        setup(pass) {
          const output = pass.writeTexture(texture, 'color-attachment');
          pass.exportResource(output, 'copy-src');
          throw new Error('setup failed');
        },
        run() {}
      })
    ).toThrow(/setup failed/i);

    graph.addCopyPass({
      id: 'replacement',
      setup(pass) {
        const output = pass.writeTexture(texture, 'color-attachment');
        pass.exportResource(output, 'copy-src');
        return { output };
      },
      run() {}
    });

    expect(graph.build().resources[0]?.currentVersion).toBe(1);
  });

  test.each([
    ['texture', 'vertex'],
    ['texture', 'undefined'],
    ['buffer', 'sampled'],
    ['buffer', 'undefined']
  ] as const)('rejects %s export state %s', (kind, finalState) => {
    const graph = new RenderGraphBuilder();
    const resource =
      kind === 'texture'
        ? graph.createTexture(textureDescriptor)
        : graph.createBuffer(bufferDescriptor);

    expect(() =>
      graph.addCopyPass({
        id: `invalid-${kind}-export`,
        setup(pass) {
          if (resource.kind === 'texture') {
            const output = pass.writeTexture(resource, 'color-attachment');
            pass.exportResource(output, finalState);
            return { output };
          }
          const output = pass.writeBuffer(resource, 'copy-dst');
          pass.exportResource(output, finalState);
          return { output };
        },
        run() {}
      })
    ).toThrow(/export.*state/i);
  });

  test.each(['texture', 'buffer'] as const)(
    'rejects a %s export state missing from the resource descriptor usage',
    (kind) => {
      const graph = new RenderGraphBuilder();
      const resource =
        kind === 'texture'
          ? graph.createTexture({ ...textureDescriptor, usage: ['color-attachment'] })
          : graph.createBuffer({ ...bufferDescriptor, usage: ['copy-dst'] });

      expect(() =>
        graph.addCopyPass({
          id: 'undeclared-export-state',
          setup(pass) {
            if (resource.kind === 'texture') {
              const output = pass.writeTexture(resource, 'color-attachment');
              pass.exportResource(output, 'copy-src');
              return { output };
            }
            const output = pass.writeBuffer(resource, 'copy-dst');
            pass.exportResource(output, 'copy-src');
            return { output };
          },
          run() {}
        })
      ).toThrow(/descriptor.*usage/i);
    }
  );

  test('captures the run callback when the pass is added', () => {
    const graph = new RenderGraphBuilder();
    const original = vi.fn();
    const replacement = vi.fn();
    const descriptor = {
      id: 'captured-run',
      setup: () => ({}),
      run: original
    };

    graph.addCopyPass(descriptor);
    descriptor.run = replacement;
    graph.build().passes[0]?.run({});

    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  test('snapshots nested setup declarations instead of freezing the contributor graph', () => {
    const graph = new RenderGraphBuilder();
    const nested = { handle: 'declaration' };
    const shell = Object.freeze({ nested });

    graph.addCopyPass({ id: 'frozen-shell', setup: () => shell, run() {} });
    const resources = graph.build().passes[0]?.resources as typeof shell;

    expect(Object.isExtensible(nested)).toBe(true);
    nested.handle = 'caller-still-owns-this';
    expect(resources.nested.handle).toBe('declaration');
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(resources.nested)).toBe(true);
    expect(() => {
      resources.nested.handle = 'mutated';
    }).toThrow();
  });

  test.each([Object.freeze(new Map([['mutable', true]])), Object.freeze(new Set(['mutable']))])(
    'rejects mutable setup containers even when their shell can be frozen',
    (container) => {
      const graph = new RenderGraphBuilder();

      expect(() =>
        graph.addCopyPass({
          id: 'mutable-container',
          setup: () => Object.freeze({ container }),
          run() {}
        })
      ).toThrow(/mutable container|Map|Set/i);
    }
  );

  test('deep freezing permits repeated references to the same frozen handle', () => {
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(textureDescriptor);

    expect(() =>
      graph.addCopyPass({
        id: 'shared-handle',
        setup: () => ({ first: texture, second: texture }),
        run() {}
      })
    ).not.toThrow();
  });
});

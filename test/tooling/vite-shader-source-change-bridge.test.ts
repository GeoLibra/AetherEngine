import { describe, expect, test } from 'vitest';
import { ViteShaderSourceChangeBridge } from '../../tools/asset-cook';
import { shaderCookHmrPlugin } from '../../tools/vite';

describe('ViteShaderSourceChangeBridge', () => {
  test('invalidates every staged shader module reached from one Vite file event', async () => {
    const modules = new Map([
      ['virtual:shader://main', { id: 'virtual:shader://main', invalidated: false }],
      ['virtual:shader://dependent', { id: 'virtual:shader://dependent', invalidated: false }]
    ]);
    const bridge = new ViteShaderSourceChangeBridge({
      recook: async () => [
        { nodeId: 'shader://main', revision: 1, status: 'staged' },
        { nodeId: 'shader://dependent', revision: 1, status: 'staged' }
      ],
      moduleIdForNode: (nodeId) => `virtual:${nodeId}`
    });
    bridge.register({
      nodeId: 'shader://main',
      sourcePath: '/workspace/main.wgsl'
    });

    const updated = await bridge.handleHotUpdate({
      file: '/workspace/main.wgsl',
      moduleGraph: {
        getModuleById: (id) => modules.get(id),
        invalidateModule: (module) => {
          module.invalidated = true;
        }
      },
      reportError: () => {
        throw new Error('Unexpected shader recook diagnostic.');
      }
    });

    expect(updated?.map(({ id }) => id)).toEqual([
      'virtual:shader://main',
      'virtual:shader://dependent'
    ]);
    expect([...modules.values()].map(({ invalidated }) => invalidated)).toEqual([true, true]);
  });

  test('reports failed recooks while preserving modules for failed and stale revisions', async () => {
    const module = { id: 'virtual:shader://main', invalidated: false };
    const diagnostics: string[] = [];
    const bridge = new ViteShaderSourceChangeBridge({
      recook: async () => [
        { nodeId: 'shader://main', revision: 2, status: 'failed', message: 'WGSL parse error' },
        { nodeId: 'shader://old', revision: 1, status: 'stale' }
      ],
      moduleIdForNode: (nodeId) => `virtual:${nodeId}`
    });
    bridge.register({ nodeId: 'shader://main', sourcePath: '/workspace/main.wgsl' });

    const updated = await bridge.handleHotUpdate({
      file: '/workspace/main.wgsl',
      moduleGraph: {
        getModuleById: () => module,
        invalidateModule: (candidate) => {
          candidate.invalidated = true;
        }
      },
      reportError: (message) => diagnostics.push(message)
    });

    expect(updated).toEqual([]);
    expect(module.invalidated).toBe(false);
    expect(diagnostics).toEqual([
      '[aether:shader-cook-hmr] Recook failed for shader://main@2: WGSL parse error'
    ]);
  });

  test('ignores file events outside the registered shader dependency closure', async () => {
    let recooks = 0;
    const bridge = new ViteShaderSourceChangeBridge({
      recook: async () => {
        recooks += 1;
        return [];
      },
      moduleIdForNode: (nodeId) => `virtual:${nodeId}`
    });
    bridge.register({ nodeId: 'shader://main', sourcePath: '/workspace/main.wgsl' });

    const updated = await bridge.handleHotUpdate({
      file: '/workspace/unrelated.ts',
      moduleGraph: {
        getModuleById: () => undefined,
        invalidateModule: () => undefined
      },
      reportError: () => undefined
    });

    expect(updated).toBeUndefined();
    expect(recooks).toBe(0);
  });
});

describe('shaderCookHmrPlugin', () => {
  test('adapts a Vite hot-update context to the shader recook coordinator', async () => {
    const module = { id: 'virtual:shader://main' };
    let invalidated = false;
    const plugin = shaderCookHmrPlugin({
      coordinator: {
        sourceChanged: async () => [
          { nodeId: 'shader://main', revision: 1, status: 'staged' as const }
        ]
      },
      registrations: [{ nodeId: 'shader://main', sourcePath: '/workspace/main.wgsl' }],
      moduleIdForNode: (nodeId) => `virtual:${nodeId}`
    });

    // @ts-expect-error focused invocation of the Vite hook contract
    const updated = await plugin.handleHotUpdate({
      file: '/workspace/main.wgsl',
      server: {
        moduleGraph: {
          getModuleById: () => module,
          invalidateModule: () => {
            invalidated = true;
          }
        },
        config: { logger: { error: () => undefined } }
      },
      modules: []
    });

    expect(updated).toEqual([module]);
    expect(invalidated).toBe(true);
  });
});

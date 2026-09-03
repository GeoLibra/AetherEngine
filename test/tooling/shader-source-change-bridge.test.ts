import { describe, expect, test } from 'vitest';
import { ShaderSourceChangeBridge } from '../../tools/asset-cook';

describe('ShaderSourceChangeBridge', () => {
  test('coalesces source and sidecar events into one canonical node recook', async () => {
    const changed: string[] = [];
    const bridge = new ShaderSourceChangeBridge({
      recook: async (nodeId) => {
        changed.push(nodeId);
      }
    });
    bridge.register({
      nodeId: 'asset://shaders/standard-lit.wgsl',
      sourcePath: '/workspace/shaders/standard-lit.wgsl',
      metadataPath: '/workspace/shaders/standard-lit.wgsl.meta.json'
    });

    const sourceEvent = bridge.notify('/workspace/shaders/standard-lit.wgsl');
    const metadataEvent = bridge.notify('/workspace/shaders/standard-lit.wgsl.meta.json');
    await Promise.all([sourceEvent, metadataEvent]);

    expect(changed).toEqual(['asset://shaders/standard-lit.wgsl']);
  });

  test('recooks every node mapped to a shared dependency in stable order', async () => {
    const changed: string[] = [];
    const bridge = new ShaderSourceChangeBridge({
      recook: async (nodeId) => {
        changed.push(nodeId);
      }
    });
    bridge.register({
      nodeId: 'asset://shaders/z.wgsl',
      sourcePath: '/workspace/shaders/z.wgsl',
      watchedDependencyPaths: ['/workspace/shaders/shared.wgsl']
    });
    bridge.register({
      nodeId: 'asset://shaders/a.wgsl',
      sourcePath: '/workspace/shaders/a.wgsl',
      watchedDependencyPaths: ['/workspace/shaders/shared.wgsl']
    });

    await bridge.notify('/workspace/shaders/shared.wgsl');

    expect(changed).toEqual(['asset://shaders/a.wgsl', 'asset://shaders/z.wgsl']);
  });

  test('ignores unknown paths and all events after disposal', async () => {
    let calls = 0;
    const bridge = new ShaderSourceChangeBridge({ recook: async () => void calls++ });
    bridge.register({
      nodeId: 'asset://shaders/main.wgsl',
      sourcePath: '/workspace/shaders/main.wgsl'
    });

    expect(await bridge.notify('/workspace/unknown.wgsl')).toEqual([]);
    bridge.dispose();
    expect(await bridge.notify('/workspace/shaders/main.wgsl')).toEqual([]);
    expect(calls).toBe(0);
  });
});

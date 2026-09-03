import { describe, expect, test, vi } from 'vitest';
import { FileSystemShaderSourceWatcher } from '../../tools/asset-cook';

describe('FileSystemShaderSourceWatcher', () => {
  test('forwards watched file events through the coalescing bridge and closes every watcher', async () => {
    const callbacks = new Map<string, (filename?: string | null) => void>();
    const closes: string[] = [];
    const changed: string[] = [];
    const watcher = new FileSystemShaderSourceWatcher({
      recook: async (nodeId) => void changed.push(nodeId),
      watch: (path, listener) => {
        callbacks.set(path, listener);
        return { close: () => void closes.push(path) };
      }
    });
    watcher.register({
      nodeId: 'asset://shaders/main.wgsl',
      sourcePath: '/workspace/shaders/main.wgsl',
      metadataPath: '/workspace/shaders/main.wgsl.meta.json'
    });

    callbacks.get('/workspace/shaders')?.('main.wgsl');
    callbacks.get('/workspace/shaders')?.('main.wgsl.meta.json');
    await vi.waitFor(() => expect(changed).toEqual(['asset://shaders/main.wgsl']));

    watcher.dispose();
    expect(closes).toEqual(['/workspace/shaders']);
    callbacks.get('/workspace/shaders')?.('main.wgsl');
    await Promise.resolve();
    expect(changed).toEqual(['asset://shaders/main.wgsl']);
  });

  test('observes creation of a dependency that did not exist when the directory watch started', async () => {
    const callbacks = new Map<string, (filename?: string | null) => void>();
    const changed: string[] = [];
    const watcher = new FileSystemShaderSourceWatcher({
      recook: async (nodeId) => void changed.push(nodeId),
      watch: (path, listener) => {
        callbacks.set(path, listener);
        return { close() {} };
      }
    });
    watcher.register({
      nodeId: 'asset://shaders/main.wgsl',
      sourcePath: '/workspace/shaders/main.wgsl',
      watchedDependencyPaths: ['/workspace/includes/future.wgsl']
    });

    callbacks.get('/workspace/includes')?.('future.wgsl');
    await vi.waitFor(() => expect(changed).toEqual(['asset://shaders/main.wgsl']));
    watcher.dispose();
  });
});

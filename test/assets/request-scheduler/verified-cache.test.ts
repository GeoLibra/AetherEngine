import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { AssetPipelineExecutor, AssetRequestStage } from '../../../src/assets/request-scheduler';
import {
  MemoryVFSProvider,
  VirtualFileSystem,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';
import type { JobScheduler } from '../../../src/jobs';
import type { RHIDevice } from '../../../src/rhi';

test.each([false, true])(
  'offline fallback accepts only expected immutable content (corrupt=%s)',
  async (corrupt) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const uri = normalizeVFSUri('asset://models/mesh.bin');
    const root = normalizeVFSUri('asset://models');
    const primary = new MemoryVFSProvider('offline-primary');
    primary.read = async () => ({ kind: 'offline', code: 'offline', message: 'Offline.' });
    const fallback = new MemoryVFSProvider('verified-cache');
    fallback.put(toNormalizedMountPath(['mesh.bin']), {
      bytes: corrupt ? new Uint8Array([3, 2, 1]) : bytes,
      revision: 'source-v1',
      resolvedUri: uri
    });
    const vfs = new VirtualFileSystem();
    vfs.mount({
      root,
      scheme: parseCanonicalVFSUri(root).scheme,
      primary,
      fallback,
      caches: [],
      policy: { consultCaches: false, fallbackOn: ['offline'] }
    });
    const executor = new AssetPipelineExecutor(vfs, {} as JobScheduler, {} as RHIDevice, {
      resolve: () => ({
        uri,
        expectedIntegrity: createHash('sha256').update(bytes).digest('hex'),
        expectedLength: bytes.byteLength,
        decodeJob: { id: 'cache-test' } as never,
        finalize: (value) => value,
        upload() {}
      })
    });
    const execution = executor.execute({
      key: 'asset:cache-test' as never,
      assetId: 'asset:cache-test' as never,
      stage: AssetRequestStage.Read,
      revision: 1,
      consumerIds: ['consumer'],
      priority: { class: 'visible', explicit: 0, dependencyDepth: 0, age: 0, retryPenalty: 0 },
      estimated: { inFlightBytes: 3 }
    });
    if (corrupt) {
      await expect(execution).rejects.toThrow('integrity');
      expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
    } else {
      await expect(execution).resolves.toBeUndefined();
      expect(executor.snapshot().retainedBytes).toBe(3);
    }
  }
);

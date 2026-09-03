import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test } from 'vitest';
import { CookArtifactPublisher } from '../../src/assets/cook';
import { IndexedDbCookArtifactStore } from '../../tools/asset-cook';

const UTF8 = new TextEncoder();

describe('IndexedDbCookArtifactStore', () => {
  test('commits objects, journals, and published pointers before reopening', async () => {
    const indexedDB = new IDBFactory();
    const store = await IndexedDbCookArtifactStore.open('cook-reopen', { indexedDB });
    const publisher = new CookArtifactPublisher(store);
    await publisher.publish({
      transactionId: 'cook-1',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-1',
      inputHashes: ['source-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('browser package') }],
      validate: () => true
    });
    store.close();

    const reopened = await IndexedDbCookArtifactStore.open('cook-reopen', { indexedDB });
    const manifest = reopened.published('shader://standard-lit');

    expect(manifest?.artifactKey).toBe('artifact-1');
    expect(reopened.transaction('cook-1')?.state).toBe('committed');
    expect(reopened.object(manifest!.outputs[0]!.hash)).toEqual(UTF8.encode('browser package'));
    reopened.close();
  });

  test('rejects a stale published-pointer CAS across IndexedDB connections', async () => {
    const indexedDB = new IDBFactory();
    const first = await IndexedDbCookArtifactStore.open('cook-cas', { indexedDB });
    const stale = await IndexedDbCookArtifactStore.open('cook-cas', { indexedDB });
    const manifest = {
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-1',
      inputHashes: ['source-1'],
      toolchainVersion: 'naga-27',
      outputs: []
    } as const;
    await first.publish('shader://standard-lit', manifest, undefined);

    await expect(
      stale.publish(
        'shader://standard-lit',
        { ...manifest, artifactKey: 'artifact-from-stale-connection' },
        undefined
      )
    ).rejects.toThrow('Cook published pointer compare-and-swap failed');

    const reopened = await IndexedDbCookArtifactStore.open('cook-cas', { indexedDB });
    expect(reopened.published('shader://standard-lit')?.artifactKey).toBe('artifact-1');
    first.close();
    stale.close();
    reopened.close();
  });

  test('collects superseded objects atomically without deleting the published closure', async () => {
    const indexedDB = new IDBFactory();
    const store = await IndexedDbCookArtifactStore.open('cook-gc', { indexedDB });
    const publisher = new CookArtifactPublisher(store);
    const first = await publisher.publish(publishRequest('gc-1', 'artifact-1', 'old payload'));
    const second = await publisher.publish(publishRequest('gc-2', 'artifact-2', 'live payload'));
    if (first.status !== 'published' || second.status !== 'published') {
      throw new Error('Expected both GC fixtures to publish.');
    }

    const report = await store.collectGarbage({
      nowMs: Date.now() + 10_000,
      minimumAgeMs: 1,
      retainedHashes: []
    });

    expect(report.deleteHashes).toEqual([first.manifest.outputs[0]!.hash]);
    expect(store.object(first.manifest.outputs[0]!.hash)).toBeUndefined();
    expect(store.object(second.manifest.outputs[0]!.hash)).toEqual(UTF8.encode('live payload'));
    store.close();
  });
});

function publishRequest(transactionId: string, artifactKey: string, payload: string) {
  return {
    transactionId,
    nodeId: 'shader://standard-lit',
    artifactKey,
    inputHashes: [`source-${artifactKey}`],
    toolchainVersion: 'naga-27',
    outputs: [{ name: 'package', bytes: UTF8.encode(payload) }],
    validate: () => true
  };
}

import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CookArtifactPublisher } from '../../src/assets/cook';
import { stableHash } from '../../src/core';
import { FileSystemCookArtifactStore } from '../../tools/asset-cook';

const temporaryDirectories: string[] = [];
const UTF8 = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('FileSystemCookArtifactStore', () => {
  test('reloads objects, journal records, and published pointers after process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
    const publisher = new CookArtifactPublisher(store);
    await publisher.publish({
      transactionId: 'cook-1',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-1',
      inputHashes: ['source-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('durable package') }],
      validate: () => true
    });

    const reopened = await FileSystemCookArtifactStore.open(directory);
    const manifest = reopened.published('shader://standard-lit');

    expect(manifest).toMatchObject({ artifactKey: 'artifact-1' });
    expect(reopened.transaction('cook-1')?.state).toBe('committed');
    expect(reopened.object(manifest!.outputs[0]!.hash)).toEqual(UTF8.encode('durable package'));
  });

  test('rejects a storage root that is a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'not-a-directory');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, 'content'));

    await expect(FileSystemCookArtifactStore.open(file)).rejects.toThrow();
  });

  test('rejects a stale published-pointer compare-and-swap across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const first = await FileSystemCookArtifactStore.open(directory);
    const stale = await FileSystemCookArtifactStore.open(directory);
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
        { ...manifest, artifactKey: 'artifact-from-stale-process' },
        undefined
      )
    ).rejects.toThrow('Cook published pointer compare-and-swap failed');
    const reopened = await FileSystemCookArtifactStore.open(directory);
    expect(reopened.published('shader://standard-lit')?.artifactKey).toBe('artifact-1');
  });

  test('recovers a published-pointer lock left by a terminated process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
    const nodeId = 'shader://standard-lit';
    const lockPath = join(directory, 'locks', `${stableHash(nodeId)}.json.lock`);
    await writeFile(lockPath, JSON.stringify({ ownerId: 'terminated-owner', pid: 2_147_483_647 }));

    await store.publish(
      nodeId,
      {
        nodeId,
        artifactKey: 'artifact-after-recovery',
        inputHashes: ['source-1'],
        toolchainVersion: 'naga-27',
        outputs: []
      },
      undefined
    );

    const reopened = await FileSystemCookArtifactStore.open(directory);
    expect(reopened.published(nodeId)?.artifactKey).toBe('artifact-after-recovery');
  });

  test('recovers when both pointer and recovery locks belong to terminated processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
    const nodeId = 'shader://standard-lit';
    const lockPath = join(directory, 'locks', `${stableHash(nodeId)}.json.lock`);
    const deadOwner = JSON.stringify({ ownerId: 'terminated-owner', pid: 2_147_483_647 });
    await writeFile(lockPath, deadOwner);
    await writeFile(`${lockPath}.recovery`, deadOwner);

    await store.publish(
      nodeId,
      {
        nodeId,
        artifactKey: 'artifact-after-double-recovery',
        inputHashes: ['source-1'],
        toolchainVersion: 'naga-27',
        outputs: []
      },
      undefined
    );

    const reopened = await FileSystemCookArtifactStore.open(directory);
    expect(reopened.published(nodeId)?.artifactKey).toBe('artifact-after-double-recovery');
  });

  test('collects expired superseded objects while retaining the published closure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
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
  });

  test('reloads durable roots on GC so an older object republished by another process is retained', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store1 = await FileSystemCookArtifactStore.open(directory);
    const publisher1 = new CookArtifactPublisher(store1);

    const first = await publisher1.publish(publishRequest('gc-1', 'artifact-1', 'initial payload'));
    const second = await publisher1.publish(
      publishRequest('gc-2', 'artifact-2', 'updated payload')
    );
    if (first.status !== 'published' || second.status !== 'published') {
      throw new Error('Expected initial publications.');
    }

    // A second store instance (simulating another process) rolls back/republishes artifact-1
    const store2 = await FileSystemCookArtifactStore.open(directory);
    const publisher2 = new CookArtifactPublisher(store2);
    const republished = await publisher2.publish({
      transactionId: 'gc-3',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-1',
      inputHashes: ['source-artifact-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('initial payload') }],
      validate: () => true
    });
    if (republished.status !== 'published') {
      throw new Error('Expected rollback publication to succeed.');
    }

    // store1 runs GC with an in-memory cache that had artifact-2 as latest.
    // Because collectGarbage reloads disk roots, artifact-1 must NOT be deleted.
    const report = await store1.collectGarbage({
      nowMs: Date.now() + 10_000,
      minimumAgeMs: 1,
      retainedHashes: []
    });

    expect(report.deleteHashes).not.toContain(first.manifest.outputs[0]!.hash);
    expect(store1.object(first.manifest.outputs[0]!.hash)).toEqual(UTF8.encode('initial payload'));
  });

  test('handles concurrent file disappearance (ENOENT) idempotently during GC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
    const publisher = new CookArtifactPublisher(store);

    await publisher.publish(publishRequest('gc-1', 'artifact-1', 'payload 1'));
    await publisher.publish(publishRequest('gc-2', 'artifact-2', 'payload 2'));

    // GC plan will be computed and executed cleanly without error even if files are missing
    const report = await store.collectGarbage({
      nowMs: Date.now() + 10_000,
      minimumAgeMs: 1,
      retainedHashes: []
    });
    expect(report.deleteHashes.length).toBe(1);
  });

  test('synchronizes concurrent publish and garbage collection without racing closures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store1 = await FileSystemCookArtifactStore.open(directory);
    const publisher1 = new CookArtifactPublisher(store1);

    const first = await publisher1.publish(publishRequest('p-1', 'artifact-1', 'initial payload'));
    const second = await publisher1.publish(publishRequest('p-2', 'artifact-2', 'updated payload'));
    if (first.status !== 'published' || second.status !== 'published') {
      throw new Error('Expected initial publications.');
    }
    const hash1 = first.manifest.outputs[0]!.hash;

    // Open store2 after p-2 so it captures artifact-2 as current revision
    const store2 = await FileSystemCookArtifactStore.open(directory);
    const publisher2 = new CookArtifactPublisher(store2);

    // Concurrently trigger GC from store1 (which would want to collect superseded artifact-1)
    // and republish/rollback to artifact-1 from publisher2
    const gcPromise = store1.collectGarbage({
      nowMs: Date.now() + 10_000,
      minimumAgeMs: 1,
      retainedHashes: []
    });
    const rollbackPromise = publisher2.publish({
      transactionId: 'p-3',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-1',
      inputHashes: ['source-artifact-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('initial payload') }],
      validate: () => true
    });

    const [gcReport, rollbackResult] = await Promise.all([gcPromise, rollbackPromise]);

    expect(rollbackResult.status).toBe('published');
    expect(gcReport).toBeDefined();

    // Verify durable closure remains fully intact
    const reopened = await FileSystemCookArtifactStore.open(directory);
    const published = reopened.published('shader://standard-lit');
    expect(published).toBeDefined();
    expect(published!.artifactKey).toBe('artifact-1');
    expect(reopened.hasObject(hash1, UTF8.encode('initial payload').byteLength)).toBe(true);
    expect(reopened.object(hash1)).toEqual(UTF8.encode('initial payload'));
  });

  test('enforces mutual exclusion between garbage collection and publish via gc.lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const store = await FileSystemCookArtifactStore.open(directory);
    const publisher = new CookArtifactPublisher(store);

    // Simulate GC actively holding locks/gc.lock
    const gcLockPath = join(directory, 'locks', 'gc.lock');
    await writeFile(
      gcLockPath,
      JSON.stringify({ ownerId: 'active-gc-holder', pid: process.pid }),
      'utf8'
    );

    let published = false;
    const publishPromise = publisher
      .publish(publishRequest('p-wait', 'artifact-wait', 'delayed payload'))
      .then((res) => {
        published = true;
        return res;
      });

    // Verify publish is blocked while gc.lock is held
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published).toBe(false);

    // Release gc.lock
    await unlink(gcLockPath);

    // Publish should now proceed and complete
    const result = await publishPromise;
    expect(result.status).toBe('published');
    expect(published).toBe(true);
  });

  test('serializes dead-lock recovery through recovery guard without clobbering new locks (A/C/B interleaving)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aether-cook-store-'));
    temporaryDirectories.push(directory);
    const storeA = await FileSystemCookArtifactStore.open(directory);
    const nodeId = 'shader://standard-lit';
    // Production lock path: ${stableHash(nodeId)}.json.lock
    const lockPath = join(directory, 'locks', `${stableHash(nodeId)}.json.lock`);

    // 1. Plant a dead lock file owned by dead process D
    const deadOwnerId = 'dead-process-d';
    await writeFile(lockPath, JSON.stringify({ ownerId: deadOwnerId, pid: 2_147_483_647 }), 'utf8');

    // 2. Contender A and Contender B both observe dead lock D.
    // Contender A successfully recovers D and deletes D's lock.
    // Immediately after, live Contender C acquires lockPath with a fresh live PID and owner.
    const liveOwnerId = 'live-process-c';
    await writeFile(lockPath, JSON.stringify({ ownerId: liveOwnerId, pid: process.pid }), 'utf8');

    // 3. Slower Contender B now executes its recovery routine targeting the lock.
    // Because lockPath is now held by living process C (ownerId !== deadOwnerId),
    // B must detect C is alive and must NOT rename or unlink C's lock.
    const storeB = await FileSystemCookArtifactStore.open(directory);
    const publisherB = new CookArtifactPublisher(storeB);

    // Contender B attempts to publish, which encounters C's live lock and will timeout
    // without destroying C's live lock.
    await expect(
      publisherB.publish(publishRequest('p-b', 'artifact-b', 'b payload'))
    ).rejects.toThrow('timed out');

    // 4. Verify C's live lock file remains 100% intact on disk
    const lockContent = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(lockContent.ownerId).toBe(liveOwnerId);
    expect(lockContent.pid).toBe(process.pid);
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

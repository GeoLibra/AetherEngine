import { describe, expect, test } from 'vitest';
import {
  CookArtifactPublisher,
  InMemoryCookArtifactStore,
  type CookArtifactManifest,
  type CookNodeId,
  type CookTransactionRecord
} from '../../src/assets/cook';

const UTF8 = new TextEncoder();

describe('CookArtifactPublisher', () => {
  test('publishes a manifest only after every content-addressed output validates', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    const bytes = UTF8.encode('compiled shader package');

    const published = await publisher.publish({
      transactionId: 'cook-1',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-key-1',
      inputHashes: ['source-hash-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes }],
      validate: ({ outputs }) => outputs.length === 1 && outputs[0]?.length === bytes.byteLength
    });

    bytes.fill(0);
    expect(published.status).toBe('published');
    expect(store.published('shader://standard-lit')).toMatchObject({
      artifactKey: 'artifact-key-1',
      outputs: [{ name: 'package', length: 23 }]
    });
    const manifest = store.published('shader://standard-lit');
    if (!manifest) throw new Error('Expected a published cook manifest.');
    expect(store.object(manifest.outputs[0]!.hash)).toEqual(UTF8.encode('compiled shader package'));
    expect(store.transaction('cook-1')?.state).toBe('committed');
  });

  test('retains the previous published revision when candidate validation fails', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    await publisher.publish({
      transactionId: 'cook-1',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-key-1',
      inputHashes: ['source-hash-1'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('last good') }],
      validate: () => true
    });

    const rejected = await publisher.publish({
      transactionId: 'cook-2',
      nodeId: 'shader://standard-lit',
      artifactKey: 'artifact-key-2',
      inputHashes: ['source-hash-2'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('invalid candidate') }],
      validate: () => false
    });

    expect(rejected).toEqual({ status: 'rejected', transactionId: 'cook-2' });
    expect(store.published('shader://standard-lit')?.artifactKey).toBe('artifact-key-1');
    expect(store.transaction('cook-2')).toMatchObject({
      state: 'aborted',
      previousPublishedRevision: 'artifact-key-1'
    });
  });

  test('recovers a complete committing transaction and aborts an incomplete output transaction', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    const committedOutput = {
      name: 'package',
      hash: 'complete-object',
      length: 8
    } as const;
    await store.putObject(committedOutput.hash, UTF8.encode('complete'));
    await store.putTransaction({
      transactionId: 'recover-complete',
      nodeId: 'shader://complete',
      artifactKey: 'artifact-complete',
      inputHashes: ['source-complete'],
      toolchainVersion: 'naga-27',
      outputs: [committedOutput],
      state: 'committing-manifest'
    });
    await store.putTransaction({
      transactionId: 'recover-incomplete',
      nodeId: 'shader://incomplete',
      artifactKey: 'artifact-incomplete',
      inputHashes: ['source-incomplete'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', hash: 'missing-object', length: 7 }],
      state: 'writing-outputs'
    });

    const report = await publisher.recover();

    expect(report).toEqual({ committed: ['recover-complete'], aborted: ['recover-incomplete'] });
    expect(store.published('shader://complete')?.artifactKey).toBe('artifact-complete');
    expect(store.published('shader://incomplete')).toBeUndefined();
    expect(store.transaction('recover-complete')?.state).toBe('committed');
    expect(store.transaction('recover-incomplete')?.state).toBe('aborted');
  });

  test('aborts an obsolete transaction before moving the published pointer', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    const validation = deferred<boolean>();
    let current = true;
    const publication = publisher.publish({
      transactionId: 'obsolete-cook',
      nodeId: 'shader://standard-lit',
      artifactKey: 'obsolete-artifact',
      inputHashes: ['obsolete-source'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('obsolete') }],
      validate: () => validation.promise,
      isCurrent: () => current
    });
    current = false;
    validation.resolve(true);

    await expect(publication).resolves.toEqual({
      status: 'obsolete',
      transactionId: 'obsolete-cook'
    });
    expect(store.published('shader://standard-lit')).toBeUndefined();
    expect(store.transaction('obsolete-cook')?.state).toBe('aborted');
  });

  test('reuses the winner when concurrent cooks publish the same artifact key', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    const request = (transactionId: string) => ({
      transactionId,
      nodeId: 'shader://shared',
      artifactKey: 'same-artifact',
      inputHashes: ['same-source'],
      toolchainVersion: 'naga-27',
      outputs: [{ name: 'package', bytes: UTF8.encode('same payload') }],
      validate: () => true
    });

    const results = await Promise.all([
      publisher.publish(request('concurrent-1')),
      publisher.publish(request('concurrent-2'))
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['published', 'reused']);
    expect(store.published('shader://shared')?.artifactKey).toBe('same-artifact');
    expect(store.transaction('concurrent-1')?.state).toBe('committed');
    expect(store.transaction('concurrent-2')?.state).toBe('committed');
  });

  test('isolates a recovery CAS conflict and continues recovering other journals', async () => {
    const store = new InMemoryCookArtifactStore();
    const publisher = new CookArtifactPublisher(store);
    await store.publish(
      'shader://conflict',
      {
        nodeId: 'shader://conflict',
        artifactKey: 'newer-winner',
        inputHashes: ['newer'],
        toolchainVersion: 'naga-27',
        outputs: []
      },
      undefined
    );
    for (const fixture of [
      { transactionId: 'a-conflict', nodeId: 'shader://conflict', hash: 'conflict-object' },
      { transactionId: 'b-complete', nodeId: 'shader://complete', hash: 'complete-object' }
    ]) {
      await store.putObject(fixture.hash, UTF8.encode('complete'));
      await store.putTransaction({
        ...manifestForRecovery(fixture.nodeId, fixture.hash),
        transactionId: fixture.transactionId,
        state: 'committing-manifest'
      });
    }

    await expect(publisher.recover()).resolves.toEqual({
      committed: ['b-complete'],
      aborted: ['a-conflict']
    });
    expect(store.published('shader://conflict')?.artifactKey).toBe('newer-winner');
    expect(store.published('shader://complete')?.artifactKey).toBe('artifact-shader://complete');
  });

  test('recovers without partial publication after every journal commit checkpoint fails', async () => {
    for (let failureAt = 1; failureAt <= 7; failureAt += 1) {
      const store = new FaultInjectingCookStore(failureAt);
      const publisher = new CookArtifactPublisher(store);
      await expect(
        publisher.publish({
          transactionId: `fault-${failureAt}`,
          nodeId: 'shader://fault-matrix',
          artifactKey: 'fault-artifact',
          inputHashes: ['fault-source'],
          toolchainVersion: 'naga-27',
          outputs: [{ name: 'package', bytes: UTF8.encode('complete') }],
          validate: () => true
        })
      ).rejects.toThrow(`Injected cook store failure at checkpoint ${failureAt}`);

      store.resume();
      await publisher.recover();
      const transaction = store.transaction(`fault-${failureAt}`);
      expect(
        transaction === undefined || ['committed', 'aborted'].includes(transaction.state)
      ).toBe(true);
      const published = store.published('shader://fault-matrix');
      expect(
        published === undefined ||
          published.outputs.every(({ hash, length }) => store.hasObject(hash, length))
      ).toBe(true);
    }
  });
});

class FaultInjectingCookStore extends InMemoryCookArtifactStore {
  #checkpoint = 0;
  #enabled = true;

  constructor(private readonly failureAt: number) {
    super();
  }

  resume(): void {
    this.#enabled = false;
  }

  override async putObject(hash: string, bytes: Uint8Array): Promise<void> {
    this.#failAtCheckpoint();
    await super.putObject(hash, bytes);
  }

  override async putTransaction(record: CookTransactionRecord): Promise<void> {
    this.#failAtCheckpoint();
    await super.putTransaction(record);
  }

  override async publish(
    nodeId: CookNodeId,
    manifest: CookArtifactManifest,
    expectedPreviousRevision: string | undefined
  ): Promise<void> {
    this.#failAtCheckpoint();
    await super.publish(nodeId, manifest, expectedPreviousRevision);
  }

  #failAtCheckpoint(): void {
    this.#checkpoint += 1;
    if (this.#enabled && this.#checkpoint === this.failureAt) {
      throw new Error(`Injected cook store failure at checkpoint ${this.failureAt}`);
    }
  }
}

function manifestForRecovery(nodeId: string, hash: string) {
  return {
    nodeId,
    artifactKey: `artifact-${nodeId}`,
    inputHashes: ['source'],
    toolchainVersion: 'naga-27',
    outputs: [{ name: 'package', hash, length: 8 }]
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

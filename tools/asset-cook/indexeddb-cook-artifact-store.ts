/** @file Browser IndexedDB provider for durable cook objects, journals, and pointers. */

import type {
  CookArtifactManifest,
  CookArtifactStore,
  CookGarbageCollectionOptions,
  CookGarbageCollectionPlan,
  CookNodeId,
  CookTransactionRecord
} from '../../src/assets/cook';
import { planCookGarbageCollection } from '../../src/assets/cook';
import { CookPublishedPointerConflictError } from '../../src/assets/cook';
import type { IndexedDbCookArtifactStoreOptions } from './types';

const DATABASE_VERSION = 1;
const STORE = Object.freeze({
  Objects: 'objects',
  Transactions: 'transactions',
  Published: 'published'
} as const);

interface StoredCookObject {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly createdAtMs: number;
}

/** Persists development cook state using committed IndexedDB transactions. */
export class IndexedDbCookArtifactStore implements CookArtifactStore {
  readonly #objects = new Map<string, Uint8Array>();
  readonly #transactions = new Map<string, CookTransactionRecord>();
  readonly #published = new Map<CookNodeId, CookArtifactManifest>();

  private constructor(private readonly database: IDBDatabase) {}

  /** Opens or upgrades a named cook database and loads its committed snapshot. */
  static async open(
    name: string,
    options: IndexedDbCookArtifactStoreOptions = {}
  ): Promise<IndexedDbCookArtifactStore> {
    if (!name) throw new Error('IndexedDB cook store name must be a non-empty string.');
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB is unavailable in this environment.');
    const database = await openDatabase(factory, name);
    const store = new IndexedDbCookArtifactStore(database);
    await store.#loadSnapshot();
    database.onversionchange = () => database.close();
    return store;
  }

  async putObject(hash: string, bytes: Uint8Array): Promise<void> {
    validateObjectHash(hash);
    const owned = bytes.slice();
    await putRecord(this.database, STORE.Objects, { hash, bytes: owned, createdAtMs: Date.now() });
    this.#objects.set(hash, owned);
  }

  async putTransaction(record: CookTransactionRecord): Promise<void> {
    const owned = copyTransaction(record);
    await putRecord(this.database, STORE.Transactions, owned);
    this.#transactions.set(record.transactionId, owned);
  }

  async publish(
    nodeId: CookNodeId,
    manifest: CookArtifactManifest,
    expectedPreviousRevision: string | undefined
  ): Promise<void> {
    const owned = copyManifest(manifest);
    const transaction = this.database.transaction(STORE.Published, 'readwrite');
    const completion = transactionCompletion(transaction);
    const objectStore = transaction.objectStore(STORE.Published);
    const request = objectStore.get(nodeId);
    let conflict: CookArtifactManifest | undefined;
    request.onsuccess = () => {
      const current = request.result as CookArtifactManifest | undefined;
      if (current?.artifactKey !== expectedPreviousRevision) {
        conflict = current === undefined ? undefined : copyManifest(current);
        transaction.abort();
        return;
      }
      objectStore.put(owned);
    };
    try {
      await completion;
    } catch (error) {
      if (
        request.readyState === 'done' &&
        request.result?.artifactKey !== expectedPreviousRevision
      ) {
        if (conflict) {
          this.#published.set(nodeId, conflict);
        } else {
          this.#published.delete(nodeId);
        }
        throw new CookPublishedPointerConflictError(nodeId, conflict?.artifactKey);
      }
      throw error;
    }
    this.#published.set(nodeId, owned);
  }

  hasObject(hash: string, length: number): boolean {
    return this.#objects.get(hash)?.byteLength === length;
  }

  transactions(): readonly CookTransactionRecord[] {
    return Object.freeze(
      [...this.#transactions.values()].sort((left, right) =>
        left.transactionId.localeCompare(right.transactionId)
      )
    );
  }

  published(nodeId: CookNodeId): CookArtifactManifest | undefined {
    return this.#published.get(nodeId);
  }

  /** Returns a detached content-addressed object payload. */
  object(hash: string): Uint8Array | undefined {
    return this.#objects.get(hash)?.slice();
  }

  /** Returns the latest committed journal snapshot for a transaction. */
  transaction(transactionId: string): CookTransactionRecord | undefined {
    return this.#transactions.get(transactionId);
  }

  /** Atomically removes expired objects outside durable and caller-retained closures. */
  async collectGarbage(options: CookGarbageCollectionOptions): Promise<CookGarbageCollectionPlan> {
    const transaction = this.database.transaction(
      [STORE.Objects, STORE.Transactions, STORE.Published],
      'readwrite'
    );
    const completion = transactionCompletion(transaction);
    const objectsRequest = transaction.objectStore(STORE.Objects).getAll();
    const transactionsRequest = transaction.objectStore(STORE.Transactions).getAll();
    const publishedRequest = transaction.objectStore(STORE.Published).getAll();
    const plan = await new Promise<CookGarbageCollectionPlan>((resolve, reject) => {
      const requests = [objectsRequest, transactionsRequest, publishedRequest];
      const tryPlan = () => {
        if (requests.some(({ readyState }) => readyState !== 'done')) return;
        try {
          const objects = objectsRequest.result as StoredCookObject[];
          const nextPlan = planCookGarbageCollection(
            {
              objects: objects.map(({ hash, bytes, createdAtMs }) => ({
                hash,
                length: bytes.byteLength,
                createdAtMs: createdAtMs ?? 0
              })),
              transactions: transactionsRequest.result as CookTransactionRecord[],
              published: publishedRequest.result as CookArtifactManifest[]
            },
            options
          );
          for (const hash of nextPlan.deleteHashes) {
            transaction.objectStore(STORE.Objects).delete(hash);
          }
          resolve(nextPlan);
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
      for (const request of requests) {
        request.onsuccess = tryPlan;
        request.onerror = () => reject(request.error ?? new Error('IndexedDB GC read failed.'));
      }
    });
    await completion;
    for (const hash of plan.deleteHashes) this.#objects.delete(hash);
    return plan;
  }

  /** Releases this connection; committed data remains available to future connections. */
  close(): void {
    this.database.close();
  }

  async #loadSnapshot(): Promise<void> {
    const transaction = this.database.transaction(
      [STORE.Objects, STORE.Transactions, STORE.Published],
      'readonly'
    );
    const completion = transactionCompletion(transaction);
    const [objects, transactions, published] = await Promise.all([
      requestResult<StoredCookObject[]>(transaction.objectStore(STORE.Objects).getAll()),
      requestResult<CookTransactionRecord[]>(transaction.objectStore(STORE.Transactions).getAll()),
      requestResult<CookArtifactManifest[]>(transaction.objectStore(STORE.Published).getAll())
    ]);
    await completion;
    for (const object of objects) this.#objects.set(object.hash, object.bytes.slice());
    for (const record of transactions) {
      this.#transactions.set(record.transactionId, copyTransaction(record));
    }
    for (const manifest of published) {
      this.#published.set(manifest.nodeId, copyManifest(manifest));
    }
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE.Objects)) {
        database.createObjectStore(STORE.Objects, { keyPath: 'hash' });
      }
      if (!database.objectStoreNames.contains(STORE.Transactions)) {
        database.createObjectStore(STORE.Transactions, { keyPath: 'transactionId' });
      }
      if (!database.objectStoreNames.contains(STORE.Published)) {
        database.createObjectStore(STORE.Published, { keyPath: 'nodeId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cook store open failed.'));
    request.onblocked = () => reject(new Error('IndexedDB cook store upgrade is blocked.'));
  });
}

async function putRecord(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite');
  const completion = transactionCompletion(transaction);
  transaction.objectStore(storeName).put(value);
  await completion;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cook request failed.'));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function validateObjectHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw new Error('Cook object hash must be a SHA-256 hex string.');
}

function copyManifest(manifest: CookArtifactManifest): CookArtifactManifest {
  return Object.freeze({
    ...manifest,
    inputHashes: Object.freeze([...manifest.inputHashes]),
    outputs: Object.freeze(manifest.outputs.map((output) => Object.freeze({ ...output })))
  });
}

function copyTransaction(record: CookTransactionRecord): CookTransactionRecord {
  return Object.freeze({
    ...copyManifest(record),
    transactionId: record.transactionId,
    state: record.state
  });
}

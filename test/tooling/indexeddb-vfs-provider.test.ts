import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  VirtualFileSystem,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  toNormalizedMountPath,
  type NormalizedMountPath
} from '../../src/assets/vfs';
import { IndexedDbVFSProvider, type IndexedDbVFSProviderOptions } from '../../tools/asset-vfs';

const names: string[] = [];
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => deleteDatabase(name)));
});

async function provider() {
  const databaseName = `aether-vfs-${crypto.randomUUID()}`;
  names.push(databaseName);
  const value = await IndexedDbVFSProvider.open({
    id: 'indexeddb',
    databaseName,
    resolvedRootUri: normalizeVFSUri('asset://cache'),
    indexedDB
  });
  return { databaseName, value };
}

describe('IndexedDbVFSProvider', () => {
  test('returns detached committed records with canonical provenance', async () => {
    const { databaseName, value } = await provider();
    await put(databaseName, {
      path: '/item.bin',
      bytes: new Uint8Array([1, 2]),
      revision: 'r1',
      mime: 'application/octet-stream',
      integrity: 'a'.repeat(64)
    });
    const first = await value.read(toNormalizedMountPath(['item.bin']), {});
    expect(first).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://cache/item.bin',
      revision: 'r1',
      contentLength: 2,
      providerId: 'indexeddb'
    });
    if (first.kind !== 'success') throw new Error('Expected IndexedDB read success.');
    first.bytes[0] = 9;
    const second = await value.read(toNormalizedMountPath(['item.bin']), {});
    expect(second.kind === 'success' && [...second.bytes]).toEqual([1, 2]);
    value.close();
  });

  test('maps missing and pre-aborted reads', async () => {
    const { value } = await provider();
    expect(await value.read(toNormalizedMountPath(['missing']), {})).toMatchObject({
      kind: 'not-found'
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await value.read(toNormalizedMountPath(['missing']), { signal: controller.signal })
    ).toMatchObject({ kind: 'aborted' });
    value.close();
  });

  test('aborts an active IndexedDB transaction when its signal is cancelled', async () => {
    const { value } = await provider();
    const controller = new AbortController();

    const resultPromise = value.read(toNormalizedMountPath(['cancelled.bin']), {
      signal: controller.signal
    });
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      kind: 'aborted',
      code: 'vfs-read-aborted'
    });
    value.close();
  });

  test('rejects malformed provider paths before starting a transaction', async () => {
    const { value } = await provider();
    await expect(value.read('../escape' as NormalizedMountPath, {})).rejects.toThrow('normalized');
    value.close();
  });

  test('rejects malformed records and maps closed connection failures without leaking diagnostics', async () => {
    const { databaseName, value } = await provider();
    await put(databaseName, { path: '/broken', bytes: 'not-bytes', revision: 'r1' });
    await put(databaseName, {
      path: '/empty-revision',
      bytes: new Uint8Array([1]),
      revision: ''
    });
    expect(await value.read(toNormalizedMountPath(['broken']), {})).toMatchObject({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-invalid-record'
    });
    expect(await value.read(toNormalizedMountPath(['empty-revision']), {})).toMatchObject({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-invalid-record'
    });
    value.close();
    const result = await value.read(toNormalizedMountPath(['broken']), {});
    expect(result).toMatchObject({ kind: 'provider-failure', code: 'vfs-indexeddb-failure' });
    expect(JSON.stringify(result)).not.toMatch(/InvalidState|database|object store/iu);
  });

  test('redacts blocked and open errors', async () => {
    const options: IndexedDbVFSProviderOptions = {
      id: 'indexeddb',
      databaseName: 'private-database',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryThat('blocked')
    };
    await expect(IndexedDbVFSProvider.open(options)).rejects.toThrow(
      'IndexedDB VFS open is blocked.'
    );
    await expect(
      IndexedDbVFSProvider.open({ ...options, indexedDB: factoryThat('error') })
    ).rejects.toThrow('IndexedDB VFS open failed.');
    await expect(
      IndexedDbVFSProvider.open({ ...options, indexedDB: factoryThat('throws') })
    ).rejects.toThrow('IndexedDB VFS open failed.');
  });

  test('fails during open when an existing database lacks the required store', async () => {
    let closed = false;
    await expect(
      IndexedDbVFSProvider.open({
        id: 'indexeddb',
        databaseName: 'wrong-schema',
        resolvedRootUri: normalizeVFSUri('asset://cache'),
        indexedDB: factoryWithDatabase({
          objectStoreNames: { contains: () => false } as unknown as DOMStringList,
          close() {
            closed = true;
          }
        })
      })
    ).rejects.toThrow('missing required object store');
    expect(closed).toBe(true);
  });

  test('validates construction input before opening IndexedDB', async () => {
    await expect(
      IndexedDbVFSProvider.open(null as unknown as IndexedDbVFSProviderOptions)
    ).rejects.toThrow('options must be an object');
    await expect(
      IndexedDbVFSProvider.open({
        id: 'indexeddb',
        databaseName: '',
        resolvedRootUri: normalizeVFSUri('asset://cache'),
        indexedDB
      })
    ).rejects.toThrow('database name must be non-empty');
    await expect(
      IndexedDbVFSProvider.open({
        id: 'indexeddb',
        databaseName: 'cache',
        resolvedRootUri: 'asset://cache/' as ReturnType<typeof normalizeVFSUri>,
        indexedDB
      })
    ).rejects.toThrow(/Invalid VFS URI|resolved root URI must be canonical/);
  });

  test('maps permission failures without exposing the IndexedDB driver error', async () => {
    const value = await IndexedDbVFSProvider.open({
      id: 'indexeddb',
      databaseName: 'private-cache',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryWithDatabase({
        transaction() {
          throw Object.assign(new Error('private permission detail'), { name: 'SecurityError' });
        }
      })
    });

    const result = await value.read(toNormalizedMountPath(['denied.bin']), {});

    expect(result).toEqual({
      kind: 'permission',
      code: 'vfs-indexeddb-permission',
      message: 'IndexedDB VFS read failed: permission.'
    });
    expect(JSON.stringify(result)).not.toContain('private permission detail');
    value.close();
  });

  test('maps quota failures to a stable redacted diagnostic', async () => {
    const value = await IndexedDbVFSProvider.open({
      id: 'indexeddb',
      databaseName: 'quota-cache',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryWithDatabase({
        transaction() {
          throw Object.assign(new Error('private quota detail'), { name: 'QuotaExceededError' });
        }
      })
    });

    const result = await value.read(toNormalizedMountPath(['quota.bin']), {});

    expect(result).toEqual({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-quota',
      message: 'IndexedDB VFS read failed: provider-failure.'
    });
    expect(JSON.stringify(result)).not.toContain('private quota detail');
    value.close();
  });

  test('reads every stored record field exactly once at the trust boundary', async () => {
    const calls = { path: 0, bytes: 0, revision: 0, mime: 0, integrity: 0 };
    const stored = {
      get path() {
        calls.path++;
        return '/item.bin';
      },
      get bytes() {
        calls.bytes++;
        return new Uint8Array([1, 2]);
      },
      get revision() {
        calls.revision++;
        return 'r1';
      },
      get mime() {
        calls.mime++;
        return 'application/octet-stream';
      },
      get integrity() {
        calls.integrity++;
        return 'a'.repeat(64);
      }
    };
    const value = await IndexedDbVFSProvider.open({
      id: 'indexeddb',
      databaseName: 'getter-cache',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryWithDatabase(databaseWithReadResult(stored))
    });

    await expect(value.read(toNormalizedMountPath(['item.bin']), {})).resolves.toMatchObject({
      kind: 'success',
      revision: 'r1'
    });
    expect(calls).toEqual({ path: 1, bytes: 1, revision: 1, mime: 1, integrity: 1 });
    value.close();
  });

  test('settles request and transaction failures without an unhandled rejection', async () => {
    const value = await IndexedDbVFSProvider.open({
      id: 'indexeddb',
      databaseName: 'failing-cache',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryWithDatabase(databaseWithFailingRead())
    });

    await expect(value.read(toNormalizedMountPath(['broken.bin']), {})).resolves.toMatchObject({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-failure'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    value.close();
  });

  test('closes its connection on version change so database deletion can finish', async () => {
    const { databaseName, value } = await provider();
    await deleteDatabase(databaseName);
    expect(await value.read(toNormalizedMountPath(['missing']), {})).toMatchObject({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-failure'
    });
  });

  test('integrates with VFS using encoded logical paths', async () => {
    const { databaseName, value } = await provider();
    await put(databaseName, {
      path: '/100% ready.bin',
      bytes: new Uint8Array([7]),
      revision: 'r1'
    });
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://cache');
    vfs.mount({
      root,
      scheme: parseCanonicalVFSUri(root).scheme,
      primary: value,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });
    expect(await vfs.read({ uri: 'asset://cache/100%25%20ready.bin' })).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://cache/100%25%20ready.bin'
    });
    value.close();
  });

  test('lets the VFS reject a stored integrity mismatch', async () => {
    const { databaseName, value } = await provider();
    await put(databaseName, {
      path: '/corrupt.bin',
      bytes: new Uint8Array([7]),
      revision: 'r1',
      integrity: '0'.repeat(64)
    });
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://cache');
    vfs.mount({
      root,
      scheme: parseCanonicalVFSUri(root).scheme,
      primary: value,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });
    expect((await vfs.read({ uri: 'asset://cache/corrupt.bin' })).kind).toBe('integrity');
    value.close();
  });

  test('reads construction getters exactly once', async () => {
    const databaseName = `aether-vfs-${crypto.randomUUID()}`;
    names.push(databaseName);
    const calls = { id: 0, name: 0, uri: 0, factory: 0 };
    const value = await IndexedDbVFSProvider.open({
      get id() {
        calls.id++;
        return 'indexeddb';
      },
      get databaseName() {
        calls.name++;
        return databaseName;
      },
      get resolvedRootUri() {
        calls.uri++;
        return normalizeVFSUri('asset://cache');
      },
      get indexedDB() {
        calls.factory++;
        return indexedDB;
      }
    });
    expect(calls).toEqual({ id: 1, name: 1, uri: 1, factory: 1 });
    value.close();
  });

  test('evaluates options.signal getter exactly once at the trust boundary', async () => {
    const { databaseName, value } = await provider();
    await put(databaseName, {
      path: '/item.bin',
      bytes: new Uint8Array([1, 2]),
      revision: 'r1'
    });
    let signalCalls = 0;
    const controller = new AbortController();
    const options = {
      get signal() {
        signalCalls++;
        return controller.signal;
      }
    };
    const result = await value.read(toNormalizedMountPath(['item.bin']), options);
    expect(result.kind).toBe('success');
    expect(signalCalls).toBe(1);
    value.close();
  });

  test('cleans up abort listener when request creation throws synchronously', async () => {
    let addCalls = 0;
    let removeCalls = 0;
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'abort') addCalls++;
      return originalAdd(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === 'abort') removeCalls++;
      return originalRemove(type, listener, options);
    };

    const value = await IndexedDbVFSProvider.open({
      id: 'indexeddb',
      databaseName: 'sync-throw-cache',
      resolvedRootUri: normalizeVFSUri('asset://cache'),
      indexedDB: factoryWithDatabase({
        transaction() {
          return {
            objectStore() {
              throw new Error('sync objectStore failure');
            },
            oncomplete: null,
            onerror: null,
            onabort: null,
            abort() {}
          } as unknown as IDBTransaction;
        }
      })
    });

    const result = await value.read(toNormalizedMountPath(['sync-throw.bin']), { signal });
    expect(result).toMatchObject({
      kind: 'provider-failure',
      code: 'vfs-indexeddb-failure'
    });
    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
    value.close();
  });
});

function factoryThat(outcome: 'blocked' | 'error' | 'throws'): IDBFactory {
  return {
    open() {
      if (outcome === 'throws') throw new Error('private factory detail');
      const request: Partial<IDBOpenDBRequest> = {};
      queueMicrotask(() => {
        const typed = request as IDBOpenDBRequest;
        if (outcome === 'blocked')
          request.onblocked?.call(typed, new Event('blocked') as IDBVersionChangeEvent);
        else request.onerror?.call(typed, new Event('error'));
      });
      return request as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;
}

function factoryWithDatabase(databaseInput: Partial<IDBDatabase>): IDBFactory {
  const database = Object.assign(
    {
      close() {},
      onversionchange: null,
      objectStoreNames: { contains: () => true }
    },
    databaseInput
  ) as IDBDatabase;
  return {
    open() {
      const request: Partial<IDBOpenDBRequest> = { result: database };
      queueMicrotask(() => {
        request.onsuccess?.call(request as IDBOpenDBRequest, new Event('success'));
      });
      return request as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;
}

function databaseWithReadResult(result: unknown): Partial<IDBDatabase> {
  return {
    transaction() {
      const request: Partial<IDBRequest<unknown>> = { result };
      const transaction: Partial<IDBTransaction> = {
        objectStore: () => ({ get: () => request }) as unknown as IDBObjectStore
      };
      queueMicrotask(() => {
        request.onsuccess?.call(request as IDBRequest, new Event('success'));
        queueMicrotask(() => {
          transaction.oncomplete?.call(transaction as IDBTransaction, new Event('complete'));
        });
      });
      return transaction as IDBTransaction;
    }
  };
}

function databaseWithFailingRead(): Partial<IDBDatabase> {
  return {
    transaction() {
      const request: Partial<IDBRequest<unknown>> = {
        error: new Error('private request detail') as DOMException
      };
      const transaction: Partial<IDBTransaction> = {
        error: new Error('private transaction detail') as DOMException,
        objectStore: () => ({ get: () => request }) as unknown as IDBObjectStore
      };
      queueMicrotask(() => {
        request.onerror?.call(request as IDBRequest, new Event('error'));
        queueMicrotask(() => {
          transaction.onerror?.call(transaction as IDBTransaction, new Event('error'));
        });
      });
      return transaction as IDBTransaction;
    }
  };
}

async function put(name: string, value: unknown): Promise<void> {
  const database = await openDatabase(name);
  const transaction = database.transaction('files', 'readwrite');
  transaction.objectStore('files').put(value);
  await completion(transaction);
  database.close();
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

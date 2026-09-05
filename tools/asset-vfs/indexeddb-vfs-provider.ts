/** @file Browser and testing full-read VFS provider backed by an injected IndexedDB factory. */

import {
  defineVFSProviderId,
  normalizeVFSUri,
  toNormalizedMountPath,
  type CanonicalVFSUri,
  type NormalizedMountPath,
  type VFSProvider,
  type VFSProviderCapabilities,
  type VFSProviderId,
  type VFSProviderReadFailure,
  type VFSProviderReadResult,
  type VFSReadOptions
} from '../../src/assets/vfs';
import type { IndexedDbVFSProviderOptions } from './types';

const VERSION = 1;
const STORE = 'files';
const CAPABILITIES: VFSProviderCapabilities = Object.freeze({
  read: true,
  range: false,
  write: false,
  watch: false
});

interface StoredFileSnapshot {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly revision: string;
  readonly mime?: string;
  readonly integrity?: string;
}

/** Reads committed, versioned byte records from one IndexedDB database. */
export class IndexedDbVFSProvider implements VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities = CAPABILITIES;
  readonly #database: IDBDatabase;
  readonly #resolvedRootUri: CanonicalVFSUri;

  private constructor(database: IDBDatabase, id: VFSProviderId, resolvedRootUri: CanonicalVFSUri) {
    this.#database = database;
    this.id = id;
    this.#resolvedRootUri = resolvedRootUri;
  }

  /**
   * Opens or validates an existing database at version 1 and ensures the required store exists.
   *
   * @throws If databaseName is empty, resolvedRootUri is non-canonical, or opening fails/blocks.
   */
  static async open(options: IndexedDbVFSProviderOptions): Promise<IndexedDbVFSProvider> {
    if (!options || typeof options !== 'object') {
      throw new Error('IndexedDB VFS options must be an object.');
    }
    const idInput = options.id;
    const name = options.databaseName;
    const rootInput = options.resolvedRootUri;
    const factory = options.indexedDB;

    const id = defineVFSProviderId(idInput);
    if (!name) throw new Error('IndexedDB VFS database name must be non-empty.');
    if (!factory) throw new Error('IndexedDB factory must be provided.');
    const root = normalizeVFSUri(rootInput);
    if (root !== rootInput) throw new Error('IndexedDB VFS resolved root URI must be canonical.');

    const database = await openDatabase(factory, name);
    // Fail-fast if database exists but missing required object store
    if (!database.objectStoreNames.contains(STORE)) {
      database.close();
      throw new Error(`IndexedDB VFS database is missing required object store '${STORE}'.`);
    }

    database.onversionchange = () => database.close();
    return new IndexedDbVFSProvider(database, id, root);
  }

  /**
   * Reads a detached byte snapshot and provenance from the object store.
   *
   * Waits for the read transaction to complete before returning success.
   */
  async read(path: NormalizedMountPath, options: VFSReadOptions): Promise<VFSProviderReadResult> {
    const segments = validatePath(path);
    const signal = options.signal;
    if (signal?.aborted) return failure('aborted', 'vfs-read-aborted');

    try {
      const rawRecord = await getRecordWithCompletion(this.#database, STORE, path, signal);

      if (signal?.aborted) return failure('aborted', 'vfs-read-aborted');
      if (rawRecord === undefined) return failure('not-found', 'vfs-indexeddb-not-found');

      const record = parseStoredRecord(rawRecord, path);
      if (!record) return failure('provider-failure', 'vfs-indexeddb-invalid-record');

      const bytes = record.bytes.slice();
      return Object.freeze({
        kind: 'success',
        bytes,
        resolvedUri: resolvedUri(this.#resolvedRootUri, segments),
        revision: record.revision,
        contentLength: bytes.byteLength,
        providerId: this.id,
        ...(record.mime === undefined ? {} : { mime: record.mime }),
        ...(record.integrity === undefined ? {} : { integrity: record.integrity })
      });
    } catch (error) {
      const name = errorName(error);
      if (signal?.aborted || name === 'AbortError') {
        return failure('aborted', 'vfs-read-aborted');
      }
      if (name === 'SecurityError' || name === 'NotAllowedError') {
        return failure('permission', 'vfs-indexeddb-permission');
      }
      if (name === 'QuotaExceededError') {
        return failure('provider-failure', 'vfs-indexeddb-quota');
      }
      return failure('provider-failure', 'vfs-indexeddb-failure');
    }
  }

  /** Releases the underlying IndexedDB database connection. */
  close(): void {
    this.#database.close();
  }
}

/** Coordinates request retrieval and transaction completion in a single promise. */
function getRecordWithCompletion(
  database: IDBDatabase,
  storeName: string,
  key: string,
  signal?: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, 'readonly');
    } catch (error) {
      reject(error);
      return;
    }

    let result: unknown;
    let isSettled = false;

    const onAbort = () => {
      if (!isSettled) {
        try {
          transaction.abort();
        } catch {
          // Transaction might already be finished or inactive.
        }
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      isSettled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    transaction.oncomplete = () => {
      cleanup();
      resolve(result);
    };
    transaction.onerror = (event) => {
      (event as Event)?.preventDefault?.();
      cleanup();
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      cleanup();
      if (signal?.aborted) {
        reject(new DOMException('Read aborted', 'AbortError'));
      } else {
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      }
    };

    try {
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = (event) => {
        (event as Event)?.preventDefault?.();
      };
    } catch (error) {
      cleanup();
      try {
        transaction.abort();
      } catch {
        // Transaction might already be inactive.
      }
      reject(error);
    }
  });
}

/** Evaluates caller-owned properties exactly once and returns a detached snapshot. */
function parseStoredRecord(value: unknown, path: string): StoredFileSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const recordPath = raw.path;
  const rawBytes = raw.bytes;
  const revision = raw.revision;
  const mime = raw.mime;
  const integrity = raw.integrity;

  if (
    recordPath !== path ||
    !(rawBytes instanceof Uint8Array) ||
    typeof revision !== 'string' ||
    revision.length === 0 ||
    (mime !== undefined && typeof mime !== 'string') ||
    (integrity !== undefined && typeof integrity !== 'string')
  ) {
    return undefined;
  }

  return {
    path: recordPath,
    bytes: rawBytes,
    revision,
    ...(mime === undefined ? {} : { mime }),
    ...(integrity === undefined ? {} : { integrity })
  };
}

function validatePath(path: NormalizedMountPath): readonly string[] {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\') || path.includes('\0')) {
    throw new Error('IndexedDB VFS path must be normalized and rooted.');
  }
  const segments = path === '/' ? [] : path.slice(1).split('/');
  toNormalizedMountPath(segments);
  return segments;
}

function resolvedUri(root: CanonicalVFSUri, segments: readonly string[]): CanonicalVFSUri {
  if (segments.length === 0) return root;
  const separator = root.endsWith('//') ? '' : '/';
  return normalizeVFSUri(`${root}${separator}${segments.map(encodeURIComponent).join('/')}`);
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, VERSION);
    } catch {
      reject(new Error('IndexedDB VFS open failed.'));
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'path' });
      }
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
    request.onerror = (event) => {
      (event as Event)?.preventDefault?.();
      if (!settled) {
        settled = true;
        reject(new Error('IndexedDB VFS open failed.'));
      }
    };
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(new Error('IndexedDB VFS open is blocked.'));
      }
    };
  });
}

function failure(kind: VFSProviderReadFailure['kind'], code: string): VFSProviderReadFailure {
  return Object.freeze({ kind, code, message: `IndexedDB VFS read failed: ${kind}.` });
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : undefined;
}

/** @file Node-only durable provider for cook objects, journals, and published pointers. */

import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { canonicalStringify, stableHash } from '../../src/core';

/** Persists cook state using atomic same-directory file replacement. */
export class FileSystemCookArtifactStore implements CookArtifactStore {
  readonly #objects = new Map<string, number>();
  readonly #transactions = new Map<string, CookTransactionRecord>();
  readonly #published = new Map<CookNodeId, CookArtifactManifest>();

  private constructor(private readonly root: string) {}

  /** Opens an existing store or creates an empty store hierarchy. */
  static async open(root: string): Promise<FileSystemCookArtifactStore> {
    await mkdir(root, { recursive: true });
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error('Cook artifact store root must be a directory.');
    const store = new FileSystemCookArtifactStore(root);
    await store.#initialize();
    return store;
  }

  async putObject(hash: string, bytes: Uint8Array): Promise<void> {
    validateFileKey(hash, 'Cook object hash');
    await writeAtomic(this.#path('objects', hash), bytes);
    this.#objects.set(hash, bytes.byteLength);
  }

  async putTransaction(record: CookTransactionRecord): Promise<void> {
    const owned = copyTransaction(record);
    await writeAtomic(
      this.#path('transactions', fileKey(record.transactionId)),
      canonicalStringify(owned)
    );
    this.#transactions.set(record.transactionId, owned);
  }

  async publish(
    nodeId: CookNodeId,
    manifest: CookArtifactManifest,
    expectedPreviousRevision: string | undefined
  ): Promise<void> {
    const owned = copyManifest(manifest);
    const pointerPath = this.#path('published', fileKey(nodeId));
    const lockPath = this.#path('locks', `${fileKey(nodeId)}.lock`);
    const gcLockPath = this.#path('locks', 'gc.lock');
    const gcLock = await acquireLock(gcLockPath);
    try {
      const lock = await acquireLock(lockPath);
      try {
        const current = await readManifest(pointerPath);
        if (current?.artifactKey !== expectedPreviousRevision) {
          if (current) this.#published.set(nodeId, current);
          throw new CookPublishedPointerConflictError(nodeId, current?.artifactKey);
        }
        await writeAtomic(pointerPath, canonicalStringify(owned));
        this.#published.set(nodeId, owned);
      } finally {
        await releaseLock(lockPath, lock);
      }
    } finally {
      await releaseLock(gcLockPath, gcLock);
    }
  }

  hasObject(hash: string, length: number): boolean {
    return this.#objects.get(hash) === length;
  }

  transactions(): readonly CookTransactionRecord[] {
    return Object.freeze(
      [...this.#transactions.values()].sort((a, b) =>
        a.transactionId.localeCompare(b.transactionId)
      )
    );
  }

  published(nodeId: CookNodeId): CookArtifactManifest | undefined {
    return this.#published.get(nodeId);
  }

  /** Reads a detached object payload for tooling and diagnostics. */
  object(hash: string): Uint8Array | undefined {
    if (!this.#objects.has(hash)) return undefined;
    return new Uint8Array(readFileSync(this.#path('objects', hash)));
  }

  /** Returns the latest immutable journal snapshot for tooling and diagnostics. */
  transaction(transactionId: string): CookTransactionRecord | undefined {
    return this.#transactions.get(transactionId);
  }

  /** Deletes expired objects outside published, in-flight, and caller-retained closures. */
  async collectGarbage(options: CookGarbageCollectionOptions): Promise<CookGarbageCollectionPlan> {
    const gcLockPath = this.#path('locks', 'gc.lock');
    const gcLock = await acquireLock(gcLockPath);
    try {
      const publishedOnDisk = new Map<CookNodeId, CookArtifactManifest>();
      const transactionsOnDisk = new Map<string, CookTransactionRecord>();
      const loadState = async (): Promise<void> => {
        await this.#loadJsonDirectory('transactions', (val) => {
          const record = copyTransaction(val as CookTransactionRecord);
          transactionsOnDisk.set(record.transactionId, record);
          this.#transactions.set(record.transactionId, record);
        });
        await this.#loadJsonDirectory('published', (val) => {
          const manifest = copyManifest(val as CookArtifactManifest);
          publishedOnDisk.set(manifest.nodeId, manifest);
          this.#published.set(manifest.nodeId, manifest);
        });
      };

      await loadState();

      const objectNames = await readdir(join(this.root, 'objects')).catch(() => []);
      const objects: { hash: string; length: number; createdAtMs: number }[] = [];
      for (const name of objectNames) {
        if (!/^[a-f0-9]{64}$/u.test(name)) continue;
        try {
          const objectStat = await stat(this.#path('objects', name));
          if (objectStat.isFile()) {
            objects.push({ hash: name, length: objectStat.size, createdAtMs: objectStat.mtimeMs });
            this.#objects.set(name, objectStat.size);
          }
        } catch (error) {
          if (!isFileSystemError(error, 'ENOENT')) throw error;
        }
      }

      const plan = planCookGarbageCollection(
        {
          objects,
          published: [...publishedOnDisk.values()],
          transactions: [...transactionsOnDisk.values()]
        },
        options
      );

      // Re-scan transactions and published pointers right before deleting objects to ensure
      // that any concurrent publication or rollback that appeared while computing the plan
      // has its output closure protected from deletion.
      await loadState();

      const retainedHashes = new Set(options.retainedHashes);
      for (const manifest of publishedOnDisk.values()) {
        for (const output of manifest.outputs) retainedHashes.add(output.hash);
      }
      for (const transaction of transactionsOnDisk.values()) {
        if (transaction.state !== 'committed' && transaction.state !== 'aborted') {
          for (const output of transaction.outputs) retainedHashes.add(output.hash);
        }
      }

      const finalizedDeleteHashes: string[] = [];
      let finalizedDeleteBytes = 0;
      for (const hash of plan.deleteHashes) {
        if (retainedHashes.has(hash)) continue;
        const objectPath = this.#path('objects', hash);
        try {
          const currentStat = await stat(objectPath);
          if (currentStat.mtimeMs > options.nowMs - options.minimumAgeMs) {
            continue;
          }
          await unlink(objectPath);
          finalizedDeleteHashes.push(hash);
          finalizedDeleteBytes += currentStat.size;
        } catch (error) {
          if (!isFileSystemError(error, 'ENOENT')) throw error;
          finalizedDeleteHashes.push(hash);
        }
        this.#objects.delete(hash);
      }
      const temporaryCutoff = Math.min(
        options.nowMs - options.minimumAgeMs,
        Date.now() - Math.max(options.minimumAgeMs, 5000)
      );
      for (const dir of ['objects', 'transactions', 'published', 'locks']) {
        for (const name of await readdir(this.#path(dir, '')).catch(() => [])) {
          const path = this.#path(dir, name);
          if (name.endsWith('.tmp') || name.includes('.dead.')) {
            try {
              const fileStat = await stat(path);
              if (fileStat.mtimeMs <= temporaryCutoff) {
                if (fileStat.isDirectory()) await rm(path, { recursive: true, force: true });
                else await unlink(path);
              }
            } catch (error) {
              if (!isFileSystemError(error, 'ENOENT')) throw error;
            }
          }
        }
      }
      return Object.freeze({
        deleteHashes: Object.freeze(finalizedDeleteHashes),
        deleteBytes: finalizedDeleteBytes,
        retainedObjects: objects.length - finalizedDeleteHashes.length
      });
    } finally {
      await releaseLock(gcLockPath, gcLock);
    }
  }

  async #initialize(): Promise<void> {
    await Promise.all(
      ['objects', 'transactions', 'published', 'locks'].map((dir) =>
        mkdir(join(this.root, dir), { recursive: true })
      )
    );
    for (const name of await readdir(join(this.root, 'objects')).catch(() => [])) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      try {
        const objectStat = await stat(this.#path('objects', name));
        if (objectStat.isFile()) this.#objects.set(name, objectStat.size);
      } catch (error) {
        if (!isFileSystemError(error, 'ENOENT')) throw error;
      }
    }
    await this.#loadJsonDirectory('transactions', (value) => {
      const record = value as CookTransactionRecord;
      this.#transactions.set(record.transactionId, copyTransaction(record));
    });
    await this.#loadJsonDirectory('published', (value) => {
      const manifest = value as CookArtifactManifest;
      this.#published.set(manifest.nodeId, copyManifest(manifest));
    });
  }

  async #loadJsonDirectory(directory: string, accept: (value: unknown) => void): Promise<void> {
    for (const name of await readdir(join(this.root, directory)).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const text = await readFile(this.#path(directory, name), 'utf8');
        accept(JSON.parse(text));
      } catch (error) {
        if (!isFileSystemError(error, 'ENOENT')) throw error;
      }
    }
  }

  #path(directory: string, name: string): string {
    return join(this.root, directory, name);
  }
}

interface CookFileLockRecord {
  readonly ownerId: string;
  readonly pid: number;
}

async function acquireLock(path: string): Promise<CookFileLockRecord> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lock = await tryAcquireLock(path);
    if (lock) return lock;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Cook published pointer lock acquisition timed out.');
}

async function tryAcquireLock(path: string): Promise<CookFileLockRecord | undefined> {
  const record: CookFileLockRecord = Object.freeze({ ownerId: randomUUID(), pid: process.pid });
  const temporaryPath = `${path}.${record.ownerId}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(canonicalStringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    return record;
  } catch (error) {
    if (isFileSystemError(error, 'EEXIST')) {
      if (path.includes('.recovery.')) {
        await cleanDeadRecoveryGuard(path);
      } else {
        await cleanDeadLock(path);
      }
      return undefined;
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function releaseLock(path: string, lock: CookFileLockRecord): Promise<void> {
  const current = await readLockRecord(path);
  if (current?.ownerId !== lock.ownerId) return;
  await unlink(path).catch((error: unknown) => {
    if (!isFileSystemError(error, 'ENOENT')) throw error;
  });
}

/**
 * Recovers a lock whose owning process terminated unexpectedly.
 * Recovery is scoped to the specific dead owner ID observed (`${path}.recovery.${deadOwnerId}`),
 * preventing contention between recovery cycles and eliminating TOCTOU races where a slow
 * contender clobbers a newly established lock or newer recovery guard.
 */
async function cleanDeadLock(path: string): Promise<void> {
  await cleanDeadLegacyRecoveryGuard(`${path}.recovery`);

  let initial: CookFileLockRecord | undefined;
  try {
    initial = await readLockRecord(path);
  } catch {
    return;
  }

  if (!initial) {
    try {
      const lockStat = await stat(path);
      if (Date.now() - lockStat.mtimeMs < 5000) return;
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return;
      return;
    }
    const quarantinePath = `${path}.dead.${randomUUID()}`;
    try {
      await rename(path, quarantinePath);
      await unlink(quarantinePath).catch(() => undefined);
    } catch {
      // Ignored
    }
    return;
  }

  if (isProcessAlive(initial.pid)) {
    return;
  }

  const deadOwnerId = initial.ownerId;
  const recoveryGuardPath = `${path}.recovery.${deadOwnerId}`;

  const guard = await tryAcquireLock(recoveryGuardPath);
  if (!guard) return;

  try {
    const current = await readLockRecord(path);
    if (current?.ownerId !== deadOwnerId) {
      return;
    }

    const quarantinePath = `${path}.dead.${deadOwnerId}.${randomUUID()}`;
    try {
      await rename(path, quarantinePath);
      await unlink(quarantinePath).catch(() => undefined);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) return;
    }
  } finally {
    await releaseLock(recoveryGuardPath, guard);
  }
}

/**
 * Recovers an abandoned recovery guard lock left behind by a terminated recovery process.
 */
async function cleanDeadRecoveryGuard(guardPath: string): Promise<void> {
  let existing: CookFileLockRecord | undefined;
  try {
    existing = await readLockRecord(guardPath);
  } catch {
    return;
  }
  if (!existing) {
    try {
      const guardStat = await stat(guardPath);
      if (Date.now() - guardStat.mtimeMs < 5000) return;
    } catch {
      return;
    }
  } else if (isProcessAlive(existing.pid)) {
    return;
  }

  const quarantinePath = `${guardPath}.dead.${randomUUID()}`;
  try {
    await rename(guardPath, quarantinePath);
    await unlink(quarantinePath).catch(() => undefined);
  } catch (error) {
    if (!isFileSystemError(error, 'ENOENT')) return;
  }
}

async function cleanDeadLegacyRecoveryGuard(recoveryPath: string): Promise<void> {
  let existing: CookFileLockRecord | undefined;
  try {
    existing = await readLockRecord(recoveryPath);
  } catch {
    return;
  }
  if (!existing || isProcessAlive(existing.pid)) return;
  const quarantinePath = `${recoveryPath}.dead.${randomUUID()}`;
  try {
    await rename(recoveryPath, quarantinePath);
    await unlink(quarantinePath).catch(() => undefined);
  } catch {
    // Ignored
  }
}

async function readLockRecord(path: string): Promise<CookFileLockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isLockRecord(value)) return undefined;
    return value;
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isLockRecord(value: unknown): value is CookFileLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ownerId?: unknown; pid?: unknown };
  return (
    typeof candidate.ownerId === 'string' &&
    candidate.ownerId.length > 0 &&
    Number.isSafeInteger(candidate.pid) &&
    (candidate.pid as number) > 0
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isFileSystemError(error, 'ESRCH')) return false;
    if (isFileSystemError(error, 'EPERM')) return true;
    throw error;
  }
}

async function readManifest(path: string): Promise<CookArtifactManifest | undefined> {
  try {
    return copyManifest(JSON.parse(await readFile(path, 'utf8')) as CookArtifactManifest);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

function fileKey(identity: string): string {
  if (!identity) throw new Error('Cook store identity must be a non-empty string.');
  return `${stableHash(identity)}.json`;
}

function validateFileKey(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hex string.`);
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

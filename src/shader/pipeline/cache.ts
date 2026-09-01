import type { RHISubmission } from '../../rhi/contracts/submission';
import { stableHash } from '../../core';

/**
 * A leased reference wrapper ensuring an artifact isn't evicted
 * from the cache while it is actively being used.
 */
export interface ShaderCacheLease<T> {
  readonly value: T;
  release(): void;
}

interface CacheEntry<T> {
  readonly key: string;
  readonly fingerprint: string;
  readonly value: T;
  refs: number; // Current lease references count
  lastUse: number; // Timestamp clock for LRU eviction priority
}

/**
 * In-memory LRU cache with leasing support.
 * Evicts oldest items when maxEntries size is exceeded, unless they are pinned.
 */
export class ShaderArtifactCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private clock = 0;

  constructor(private readonly options: Readonly<{ maxEntries: number }>) {
    if (options.maxEntries < 1) throw new Error('Shader cache maxEntries must be positive.');
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Retrieves a cache lease by key and checks fingerprint validity to guard against collisions.
   */
  get(key: string, fingerprint: string): ShaderCacheLease<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.fingerprint !== fingerprint)
      throw new Error(`Shader cache collision guard rejected key "${key}".`);
    return this.lease(entry);
  }

  /**
   * Caches an artifact and returns a lease. Evicts old unused entries if full.
   */
  set(key: string, fingerprint: string, value: T): ShaderCacheLease<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(`Shader cache collision guard rejected key "${key}".`);
      return this.lease(existing);
    }
    const entry: CacheEntry<T> = { key, fingerprint, value, refs: 0, lastUse: ++this.clock };
    this.entries.set(key, entry);
    const result = this.lease(entry);
    this.evict();
    return result;
  }

  /**
   * Pins a cache artifact to prevent eviction while an active RHI command submission is executing.
   */
  retainForSubmission(key: string, fingerprint: string, submission: RHISubmission): boolean {
    const lease = this.get(key, fingerprint);
    if (!lease) return false;
    void submission.done.then(
      () => lease.release(),
      () => lease.release()
    );
    return true;
  }

  private lease(entry: CacheEntry<T>): ShaderCacheLease<T> {
    entry.refs++;
    entry.lastUse = ++this.clock;
    let released = false;
    return Object.freeze({
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        this.evict();
      }
    });
  }

  /**
   * Evicts the least recently used entries.
   * A pinned LRU entry blocks eviction of newer entries; the cache may temporarily exceed
   * capacity until the submission/consumer lease reaches a terminal state.
   */
  private evict(): void {
    while (this.entries.size > this.options.maxEntries) {
      const candidate = [...this.entries.values()].sort((a, b) => a.lastUse - b.lastUse)[0];
      if (!candidate || candidate.refs !== 0) return;
      this.entries.delete(candidate.key);
    }
  }
}

export interface PersistentShaderCacheRecord<T> {
  readonly key: string;
  readonly fingerprint: string;
  readonly backendVersion: number;
  readonly deviceKey: string;
  readonly payload: T;
  readonly integrity: string;
}

export function createPersistentShaderCacheRecord<T>(
  input: Omit<PersistentShaderCacheRecord<T>, 'integrity'>
): PersistentShaderCacheRecord<T> {
  const integrity = persistentIntegrity(input);
  return Object.freeze({ ...input, integrity });
}

export function validatePersistentShaderCacheRecord<T>(
  record: PersistentShaderCacheRecord<T>,
  expected: Readonly<{ backendVersion: number; deviceKey: string }>
):
  | Readonly<{ ok: true; payload: T }>
  | Readonly<{ ok: false; reason: 'version-mismatch' | 'device-mismatch' | 'integrity-mismatch' }> {
  if (record.backendVersion !== expected.backendVersion)
    return Object.freeze({ ok: false, reason: 'version-mismatch' });
  if (record.deviceKey !== expected.deviceKey)
    return Object.freeze({ ok: false, reason: 'device-mismatch' });
  if (record.integrity !== persistentIntegrity(record))
    return Object.freeze({ ok: false, reason: 'integrity-mismatch' });
  return Object.freeze({ ok: true, payload: record.payload });
}

function persistentIntegrity(
  record: Readonly<{
    key: string;
    fingerprint: string;
    backendVersion: number;
    deviceKey: string;
    payload: unknown;
  }>
): string {
  return stableHash({
    key: record.key,
    fingerprint: record.fingerprint,
    backendVersion: record.backendVersion,
    deviceKey: record.deviceKey,
    payload: record.payload
  });
}

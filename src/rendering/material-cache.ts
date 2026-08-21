import type { RHISubmission } from '../rhi/contracts/submission';
import { isFactoryCanonicalKey, type CanonicalKey } from './pipeline-resolver';
import type { FeaturePolicyCacheInvalidation } from '../feature-policy/types';

interface CacheKeyParts {
  readonly deviceGeneration: number;
  readonly featurePolicyHash?: string;
  readonly resources?: readonly Readonly<{
    readonly group: number;
    readonly binding: number;
    readonly assetPayloadVersion: number;
    readonly resourceGeneration: number;
  }>[];
  readonly bufferAllocationGeneration?: number;
  readonly ringGeneration?: number;
}

type CacheEntryState = 'live' | 'retired' | 'destroyed';

interface CacheEntry<T> {
  readonly key: CanonicalKey<CacheKeyParts>;
  readonly value: T;
  readonly generationSignature: string;
  readonly submissions: Set<RHISubmission>;
  state: CacheEntryState;
  localLeases: number;
}

export interface SubmissionRetainedCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly published: number;
  readonly retired: number;
  readonly destroyed: number;
  readonly fencePending: number;
  readonly staleHitRejected: number;
  readonly staleReuse: number;
}

export interface SubmissionRetainedCacheOptions<T> {
  readonly destroy?: (value: T) => void;
}

export interface SubmissionRetainedCacheLease<T> {
  readonly value: T;
  retain(submission: RHISubmission): void;
  release(): void;
}

export class SubmissionRetainedCache<T> {
  readonly #buckets = new Map<string, Map<string, CacheEntry<T>>>();
  readonly #destroy: ((value: T) => void) | undefined;
  readonly #destroyErrors: unknown[] = [];
  #hits = 0;
  #misses = 0;
  #published = 0;
  #retired = 0;
  #destroyed = 0;
  #fencePending = 0;
  #staleHitRejected = 0;

  constructor(options: SubmissionRetainedCacheOptions<T> = {}) {
    this.#destroy = options.destroy;
  }

  publish<P extends CacheKeyParts>(key: CanonicalKey<P>, value: T): void {
    if (!isFactoryCanonicalKey(key)) throw new Error('Expected a factory-owned canonical key.');
    const bucket = this.#buckets.get(key.hash) ?? new Map<string, CacheEntry<T>>();
    const existing = bucket.get(key.canonicalValue);
    if (existing !== undefined) {
      if (existing.state === 'retired') throw new Error('Cache key is retired and still retained.');
      throw new Error('Cache key is already published.');
    }
    const ownedKey = key as unknown as CanonicalKey<CacheKeyParts>;
    bucket.set(key.canonicalValue, {
      key: ownedKey,
      value,
      generationSignature: generationSignature(key.parts as unknown as CacheKeyParts),
      submissions: new Set(),
      state: 'live',
      localLeases: 0
    });
    this.#buckets.set(key.hash, bucket);
    this.#published += 1;
  }

  acquire<P extends CacheKeyParts>(
    key: CanonicalKey<P>
  ): SubmissionRetainedCacheLease<T> | undefined {
    if (!isFactoryCanonicalKey(key)) {
      this.#misses += 1;
      this.#staleHitRejected += 1;
      return undefined;
    }
    const entry = this.#buckets.get(key.hash)?.get(key.canonicalValue);
    if (entry === undefined || entry.state !== 'live') {
      this.#misses += 1;
      return undefined;
    }
    if (entry.generationSignature !== generationSignature(key.parts as unknown as CacheKeyParts)) {
      this.#misses += 1;
      this.#staleHitRejected += 1;
      return undefined;
    }
    this.#hits += 1;
    entry.localLeases += 1;
    return this.#createLease(entry);
  }

  retire<P extends CacheKeyParts>(key: CanonicalKey<P>): boolean {
    if (!isFactoryCanonicalKey(key)) return false;
    const entry = this.#buckets.get(key.hash)?.get(key.canonicalValue);
    if (entry === undefined || entry.state !== 'live') return false;
    entry.state = 'retired';
    this.#retired += 1;
    this.#tryDestroy(entry);
    return true;
  }

  invalidateDevice(deviceGeneration: number): void {
    const entries = [...this.#buckets.values()].flatMap((bucket) => [...bucket.values()]);
    for (const entry of entries) {
      if (entry.key.parts.deviceGeneration !== deviceGeneration || entry.state !== 'live') continue;
      entry.state = 'retired';
      this.#retired += 1;
      this.#tryDestroy(entry);
    }
  }

  /** Retires only pipeline entries produced by the previous policy-domain hash. */
  invalidateFeaturePolicy(invalidation: FeaturePolicyCacheInvalidation): void {
    if (invalidation.domain !== 'shader-pipeline' || invalidation.previousHash === null) return;
    const entries = [...this.#buckets.values()].flatMap((bucket) => [...bucket.values()]);
    for (const entry of entries) {
      if (entry.key.parts.featurePolicyHash !== invalidation.previousHash || entry.state !== 'live')
        continue;
      entry.state = 'retired';
      this.#retired += 1;
      this.#tryDestroy(entry);
    }
  }

  metrics(): Readonly<SubmissionRetainedCacheMetrics> {
    return Object.freeze({
      hits: this.#hits,
      misses: this.#misses,
      published: this.#published,
      retired: this.#retired,
      destroyed: this.#destroyed,
      fencePending: this.#fencePending,
      staleHitRejected: this.#staleHitRejected,
      staleReuse: 0
    });
  }

  destroyErrors(): readonly unknown[] {
    return Object.freeze([...this.#destroyErrors]);
  }

  #createLease(entry: CacheEntry<T>): SubmissionRetainedCacheLease<T> {
    let released = false;
    return Object.freeze({
      value: entry.value,
      retain: (submission: RHISubmission) => {
        if (released) throw new Error('Cache lease has already been released.');
        if (submission.status !== 'pending' || entry.submissions.has(submission)) return;
        entry.submissions.add(submission);
        this.#fencePending += 1;
        void submission.done.then(
          () => this.#releaseSubmission(entry, submission),
          () => this.#releaseSubmission(entry, submission)
        );
      },
      release: () => {
        if (released) return;
        released = true;
        entry.localLeases -= 1;
        this.#tryDestroy(entry);
      }
    });
  }

  #releaseSubmission(entry: CacheEntry<T>, submission: RHISubmission): void {
    if (!entry.submissions.delete(submission)) return;
    this.#fencePending -= 1;
    this.#tryDestroy(entry);
  }

  #tryDestroy(entry: CacheEntry<T>): void {
    if (entry.state !== 'retired' || entry.localLeases !== 0 || entry.submissions.size !== 0)
      return;
    entry.state = 'destroyed';
    this.#buckets.get(entry.key.hash)?.delete(entry.key.canonicalValue);
    if (this.#buckets.get(entry.key.hash)?.size === 0) this.#buckets.delete(entry.key.hash);
    this.#destroyed += 1;
    try {
      this.#destroy?.(entry.value);
    } catch (error) {
      this.#destroyErrors.push(error);
    }
  }
}

function generationSignature(parts: CacheKeyParts): string {
  return JSON.stringify({
    deviceGeneration: parts.deviceGeneration,
    resources: parts.resources?.map((resource) => ({
      group: resource.group,
      binding: resource.binding,
      assetPayloadVersion: resource.assetPayloadVersion,
      resourceGeneration: resource.resourceGeneration
    })),
    bufferAllocationGeneration: parts.bufferAllocationGeneration,
    ringGeneration: parts.ringGeneration
  });
}

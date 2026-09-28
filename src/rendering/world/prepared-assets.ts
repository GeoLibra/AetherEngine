import type { RHISubmission } from '../../rhi';
import type { FeaturePolicyCacheInvalidation } from '../../feature-policy/types';
import type {
  PreparedAsset,
  PreparedAssetLease,
  PreparedAssetRegistrySnapshot,
  PreparedAssetResidencySnapshot,
  PreparedVariantKey
} from './types';

const EMPTY_PREPARED_ASSET_RESIDENCY: readonly PreparedAssetResidencySnapshot[] = Object.freeze([]);

interface Entry<T> {
  readonly prepared: PreparedAsset<T>;
  readonly destroy: (value: T) => void;
  leases: number; // Outstanding leases in active recording passes
  submissions: number; // Outstanding active submissions on the GPU queue
  retired: boolean; // Marked for discard when leases/submissions drop to zero
  destroyed: boolean; // Keeps track of physical destruction status
  readonly bytes: number | null;
}

/**
 * PreparedAssetRegistry coordinates the lifecycle of GPU-facing assets.
 * Implements strict deferred destruction: assets are only physically destroyed when
 * they are retired AND all outstanding leases and GPU submissions have finished.
 */
export class PreparedAssetRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();

  private readonly variantsByAssetId = new Map<string, Set<string>>();

  /** Returns the renderer-owned lifetime state for one prepared GPU variant. */
  inspect(key: PreparedVariantKey): PreparedAssetResidencySnapshot | undefined {
    const entry = this.entries.get(preparedKey(key));
    if (entry === undefined) return undefined;
    return Object.freeze({
      key: Object.freeze({ ...entry.prepared.key }),
      state: entry.retired ? 'evicting' : 'resident',
      bytes: entry.bytes,
      activeLeases: entry.leases,
      activeSubmissions: entry.submissions
    });
  }

  /** Returns snapshots for every retained GPU variant owned by one stable asset ID. */
  inspectAsset(assetId: string): readonly PreparedAssetResidencySnapshot[] {
    if (typeof assetId !== 'string' || assetId.trim().length === 0) {
      throw new Error('Prepared asset lookup requires a non-empty asset ID.');
    }
    const variantIds = this.variantsByAssetId.get(assetId);
    if (variantIds === undefined) return EMPTY_PREPARED_ASSET_RESIDENCY;
    return Object.freeze(
      [...variantIds].map((id) => {
        const entry = this.entries.get(id);
        if (entry === undefined) {
          throw new Error(`Prepared asset index references missing variant: ${id}`);
        }
        return Object.freeze({
          key: Object.freeze({ ...entry.prepared.key }),
          state: entry.retired ? ('evicting' as const) : ('resident' as const),
          bytes: entry.bytes,
          activeLeases: entry.leases,
          activeSubmissions: entry.submissions
        });
      })
    );
  }

  /** Summarizes published and fence-pending prepared GPU variants for status composition. */
  snapshot(): PreparedAssetRegistrySnapshot {
    let residentVariants = 0;
    let evictingVariants = 0;
    let knownBytes = 0;
    let unknownByteVariants = 0;
    let activeLeases = 0;
    let activeSubmissions = 0;
    for (const entry of this.entries.values()) {
      if (entry.retired) evictingVariants += 1;
      else residentVariants += 1;
      if (entry.bytes === null) unknownByteVariants += 1;
      else knownBytes += entry.bytes;
      activeLeases += entry.leases;
      activeSubmissions += entry.submissions;
    }
    return Object.freeze({
      residentVariants,
      evictingVariants,
      knownBytes,
      unknownByteVariants,
      activeLeases,
      activeSubmissions
    });
  }

  /**
   * Publishes a newly prepared GPU asset to the registry.
   */
  publish<T>(prepared: PreparedAsset<T>, destroy: (value: T) => void = () => undefined): void {
    this.publishBatch([prepared], destroy);
  }

  /**
   * Publishes a non-empty set of variants together after validating every identity.
   *
   * No observer can acquire a partial set: validation and snapshot construction finish before
   * the synchronous map insertion begins. A duplicate leaves the registry unchanged.
   */
  publishBatch<T>(
    prepared: readonly PreparedAsset<T>[],
    destroy: (value: T) => void = () => undefined
  ): void {
    if (prepared.length === 0) throw new Error('Prepared asset batch must not be empty.');
    const seen = new Set<string>();
    const entries = prepared.map((asset) => {
      const id = preparedKey(asset.key);
      if (seen.has(id)) throw new Error(`Prepared asset batch has duplicate variant: ${id}`);
      if (this.entries.has(id)) throw new Error(`Prepared asset variant already exists: ${id}`);
      seen.add(id);
      const entry: Entry<unknown> = {
        prepared: deepFreezePrepared(asset),
        destroy: destroy as (value: unknown) => void,
        leases: 0,
        submissions: 0,
        retired: false,
        destroyed: false,
        bytes: readByteLength(asset.value)
      };
      return { id, entry };
    });
    for (const { id, entry } of entries) {
      this.entries.set(id, entry);
      const assetId = entry.prepared.key.assetId;
      let variants = this.variantsByAssetId.get(assetId);
      if (variants === undefined) {
        variants = new Set();
        this.variantsByAssetId.set(assetId, variants);
      }
      variants.add(id);
    }
  }

  /**
   * Acquires a lease on a prepared asset variant. Returns undefined if the asset is missing
   * or has been retired.
   */
  acquire<T>(key: PreparedVariantKey): PreparedAssetLease<T> | undefined {
    const entry = this.entries.get(preparedKey(key)) as Entry<T> | undefined;
    if (!entry || entry.retired) return undefined;
    entry.leases++;
    let disposed = false;
    const registry = this;
    return Object.freeze({
      prepared: entry.prepared,
      get disposed() {
        return disposed;
      },
      retainUntil(submission: RHISubmission) {
        if (disposed) throw new Error('Cannot retain a disposed prepared asset lease.');
        entry.submissions++;
        // Release the submission reservation once the GPU has finished executing it.
        const release = () => {
          entry.submissions--;
          registry.collect(entry, preparedKey(key));
        };
        // Both terminal branches release ownership without creating an unhandled rejection.
        void submission.done.then(release, release);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        entry.leases--;
        registry.collect(entry, preparedKey(key));
      }
    });
  }

  /**
   * Retires an asset variant, marking it for collection when it becomes unused.
   */
  retire(key: PreparedVariantKey): void {
    const id = preparedKey(key);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.retired = true;
    this.collect(entry, id);
  }

  /**
   * Retires all asset variants associated with a specific device generation (e.g. on device loss).
   */
  invalidateDevice(deviceGeneration: number): void {
    for (const [id, entry] of this.entries)
      if (entry.prepared.key.deviceGeneration === deviceGeneration) {
        entry.retired = true;
        this.collect(entry, id);
      }
  }

  /**
   * Retires variants produced by the previous prepared-asset policy identity.
   * In-flight leases and submissions continue to own the physical resources.
   */
  invalidateFeaturePolicy(invalidation: FeaturePolicyCacheInvalidation): void {
    if (invalidation.domain !== 'prepared-asset' || invalidation.previousHash === null) return;
    for (const [id, entry] of this.entries) {
      if (entry.prepared.key.featurePolicyKey !== invalidation.previousHash || entry.retired)
        continue;
      entry.retired = true;
      this.collect(entry, id);
    }
  }

  /**
   * Performs physical destruction of the GPU resource once all references are released.
   */
  private collect<T>(entry: Entry<T>, id: string): void {
    if (!entry.retired || entry.leases > 0 || entry.submissions > 0 || entry.destroyed) return;
    entry.destroyed = true;
    this.entries.delete(id);
    const assetId = entry.prepared.key.assetId;
    const variants = this.variantsByAssetId.get(assetId);
    if (variants === undefined || !variants.delete(id)) {
      throw new Error(`Prepared asset index is missing collected variant: ${id}`);
    }
    if (variants.size === 0) this.variantsByAssetId.delete(assetId);
    entry.destroy(entry.prepared.value);
  }
}

function readByteLength(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || !('byteLength' in value)) return null;
  const byteLength = value.byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return null;
  }
  return byteLength;
}

/**
 * Standard serialization format for PreparedVariantKey properties.
 */
export function preparedKey(key: PreparedVariantKey): string {
  return [
    key.assetId,
    key.payloadVersion,
    key.deviceGeneration,
    key.featurePolicyKey,
    key.abiVersion
  ].join('|');
}

function deepFreezePrepared<T>(prepared: PreparedAsset<T>): PreparedAsset<T> {
  return Object.freeze({ key: Object.freeze({ ...prepared.key }), value: prepared.value });
}

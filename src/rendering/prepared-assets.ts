import type { RHISubmission } from '../rhi';
import type { FeaturePolicyCacheInvalidation } from '../feature-policy/types';

/**
 * Key that uniquely identifies a prepared asset variant on the GPU.
 * Incorporates asset ID, version, device generation, feature policies, and ABI versions.
 */
export interface PreparedVariantKey {
  readonly assetId: string;
  readonly payloadVersion: number;
  readonly deviceGeneration: number;
  readonly featurePolicyKey: string;
  readonly abiVersion: string;
}

/**
 * Encapsulates the GPU-facing object (e.g. BindGroup, Texture, Buffer) along with its variant key.
 */
export interface PreparedAsset<T> {
  readonly key: PreparedVariantKey;
  readonly value: T;
}

/**
 * A reference-counted handle lease ensuring that the prepared GPU asset remains alive.
 * It must be held while recording commands, and registered via `retainUntil()` on RHI submissions.
 */
export interface PreparedAssetLease<T> {
  readonly prepared: PreparedAsset<T>;
  readonly disposed: boolean;
  retainUntil(submission: RHISubmission): void;
  dispose(): void;
}

interface Entry<T> {
  readonly prepared: PreparedAsset<T>;
  readonly destroy: (value: T) => void;
  leases: number; // Outstanding leases in active recording passes
  submissions: number; // Outstanding active submissions on the GPU queue
  retired: boolean; // Marked for discard when leases/submissions drop to zero
  destroyed: boolean; // Keeps track of physical destruction status
}

/**
 * PreparedAssetRegistry coordinates the lifecycle of GPU-facing assets.
 * Implements strict deferred destruction: assets are only physically destroyed when
 * they are retired AND all outstanding leases and GPU submissions have finished.
 */
export class PreparedAssetRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();

  /**
   * Publishes a newly prepared GPU asset to the registry.
   */
  publish<T>(prepared: PreparedAsset<T>, destroy: (value: T) => void = () => undefined): void {
    const id = preparedKey(prepared.key);
    if (this.entries.has(id)) throw new Error(`Prepared asset variant already exists: ${id}`);
    this.entries.set(id, {
      prepared: deepFreezePrepared(prepared),
      destroy: destroy as (value: unknown) => void,
      leases: 0,
      submissions: 0,
      retired: false,
      destroyed: false
    });
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
        void submission.done.finally(() => {
          entry.submissions--;
          registry.collect(entry, preparedKey(key));
        });
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
    entry.destroy(entry.prepared.value);
  }
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

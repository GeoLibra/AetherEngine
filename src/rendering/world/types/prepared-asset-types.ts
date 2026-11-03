import type { RHISubmission } from '../../../rhi';

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

/** Renderer-owned residency facts for one GPU variant. Byte size is null when its payload
 * does not expose an authoritative `byteLength` number. */
export interface PreparedAssetResidencySnapshot {
  readonly key: PreparedVariantKey;
  readonly state: 'resident' | 'evicting';
  readonly bytes: number | null;
  readonly activeLeases: number;
  readonly activeSubmissions: number;
}

/** Aggregate prepared GPU residency counters for diagnostics and Asset Status composition. */
export interface PreparedAssetRegistrySnapshot {
  readonly residentVariants: number;
  readonly evictingVariants: number;
  readonly knownBytes: number;
  readonly unknownByteVariants: number;
  readonly activeLeases: number;
  readonly activeSubmissions: number;
}

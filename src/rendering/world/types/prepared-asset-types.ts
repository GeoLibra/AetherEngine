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

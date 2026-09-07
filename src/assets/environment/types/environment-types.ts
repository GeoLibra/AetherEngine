/**
 * @file Runtime Environment asset types and handle declarations.
 * Exposes strongly typed, validated asset handles without RHI dependencies.
 */

import type { AssetHandle, AssetId } from '../../types';
import type {
  BrdfLutArtifactV1,
  EnvironmentArtifact,
  EnvironmentArtifactV1,
  EnvironmentArtifactV2,
  BackgroundPayload
} from '../../../../tools/asset-cook/environment/artifact/types';

export type {
  BackgroundPayload,
  EnvironmentArtifact,
  EnvironmentArtifactV1,
  EnvironmentArtifactV2
};

declare const environmentAssetBrand: unique symbol;

/**
 * CPU-level canonical Environment asset descriptor.
 * Validated immutable representation containing artifact manifest metadata and CPU byte references.
 * Invariant: Never contains RHI devices, textures, or GPU buffer allocations.
 */
export interface EnvironmentAsset {
  readonly [environmentAssetBrand]: true;
  readonly assetId: AssetId;
  readonly artifact: EnvironmentArtifact;
  readonly irradianceBytes: Uint8Array;
  readonly radianceBytes: Uint8Array;
  readonly brdfLutArtifact: BrdfLutArtifactV1;
  readonly brdfLutBytes: Uint8Array;
  readonly panoramaBytes?: Uint8Array;
}

/** Strongly typed handle to an environment asset. */
export type EnvironmentHandle = AssetHandle<EnvironmentAsset>;

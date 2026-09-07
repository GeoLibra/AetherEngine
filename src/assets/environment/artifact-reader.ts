/**
 * @file VFS reader for cooked EnvironmentArtifact@1 packages.
 * Validates manifest schemas and verifies blob integrity digests.
 */

import type { VirtualFileSystem } from '../vfs';
import {
  deserializeBrdfLutManifest,
  deserializeEnvironmentManifest,
  validateEnvironmentArtifact,
  validateBrdfLutArtifact
} from '../../../tools/asset-cook/environment/artifact/manifest-codec';
import type { EnvironmentAsset, EnvironmentHandle } from './types';

export interface ReadEnvironmentOptions {
  readonly vfs: VirtualFileSystem;
  readonly baseUri: string; // e.g. "asset://environment/studio"
  readonly handle: EnvironmentHandle;
}

export async function readEnvironmentFromVfs(
  options: ReadEnvironmentOptions
): Promise<EnvironmentAsset> {
  const { vfs, baseUri, handle } = options;
  const manifestUri = `${baseUri.replace(/\/+$/, '')}/environment.manifest.json`;

  // 1. Read environment manifest
  const manifestResult = await vfs.read({ uri: manifestUri });
  if (manifestResult.kind !== 'success') {
    throw new Error(
      `Failed to read environment manifest at "${manifestUri}": ${manifestResult.kind}`
    );
  }

  const manifestJson = new TextDecoder('utf-8').decode(manifestResult.bytes);
  const artifact = deserializeEnvironmentManifest(manifestJson);
  validateEnvironmentArtifact(artifact);

  // 2. Read irradiance blob
  const irradianceUri = `${baseUri}/blobs/${artifact.irradiance.blobHash}.bin`;
  const irradianceResult = await vfs.read({
    uri: irradianceUri,
    expectedLength: artifact.irradiance.byteLength,
    expectedIntegrity: `sha256:${artifact.irradiance.blobHash}`
  });
  if (irradianceResult.kind !== 'success') {
    throw new Error(`Failed to read irradiance blob "${irradianceUri}": ${irradianceResult.kind}`);
  }

  // 3. Read radiance blob
  const radianceUri = `${baseUri}/blobs/${artifact.radiance.blobHash}.bin`;
  const radianceResult = await vfs.read({
    uri: radianceUri,
    expectedLength: artifact.radiance.byteLength,
    expectedIntegrity: `sha256:${artifact.radiance.blobHash}`
  });
  if (radianceResult.kind !== 'success') {
    throw new Error(`Failed to read radiance blob "${radianceUri}": ${radianceResult.kind}`);
  }

  // 4. Read shared BRDF LUT manifest and blob
  const lutManifestUri = `${baseUri}/brdf-lut/lut.manifest.json`;
  const lutManifestResult = await vfs.read({ uri: lutManifestUri });
  if (lutManifestResult.kind !== 'success') {
    throw new Error(
      `Failed to read BRDF LUT manifest "${lutManifestUri}": ${lutManifestResult.kind}`
    );
  }

  const lutJson = new TextDecoder('utf-8').decode(lutManifestResult.bytes);
  const brdfLutArtifact = deserializeBrdfLutManifest(lutJson);
  validateBrdfLutArtifact(brdfLutArtifact);

  const lutBlobUri = `${baseUri}/brdf-lut/blobs/${brdfLutArtifact.payload.blobHash}.bin`;
  const lutBlobResult = await vfs.read({
    uri: lutBlobUri,
    expectedLength: brdfLutArtifact.payload.byteLength,
    expectedIntegrity: `sha256:${brdfLutArtifact.payload.blobHash}`
  });
  if (lutBlobResult.kind !== 'success') {
    throw new Error(`Failed to read BRDF LUT blob "${lutBlobUri}": ${lutBlobResult.kind}`);
  }

  return Object.freeze({
    assetId: handle.assetId,
    artifact,
    irradianceBytes: irradianceResult.bytes,
    radianceBytes: radianceResult.bytes,
    brdfLutArtifact,
    brdfLutBytes: lutBlobResult.bytes
  }) as unknown as EnvironmentAsset;
}

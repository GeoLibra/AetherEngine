import { describe, expect, it } from 'vitest';
import {
  createAssetHandle,
  EnvironmentAssetType,
  EnvironmentAssetProvider,
  readEnvironmentFromVfs,
  type EnvironmentAsset,
  type EnvironmentHandle
} from '../../src/assets';
import { VirtualFileSystem, normalizeVFSUri, parseCanonicalVFSUri } from '../../src/assets/vfs';
import {
  cookEnvironmentPanorama,
  DEFAULT_COOK_RECIPES,
  serializeEnvironmentManifest,
  serializeBrdfLutManifest
} from '../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../benchmark/environment-cook/fixtures';

describe('Environment runtime assets and VFS integration', () => {
  it('creates and validates strongly typed environment handles', () => {
    const handle = createAssetHandle(EnvironmentAssetType, 'environment.studio-sunset');
    expect(handle.type).toBe('asset.environment');
    expect(handle.assetId).toBe('environment.studio-sunset');
  });

  it('manages CPU-level publication revisions and last-good retention', () => {
    const provider = new EnvironmentAssetProvider();
    expect(provider.revision()).toBe(0);
    expect(provider.current()).toBeUndefined();

    const dummyAsset1 = { assetId: 'env.1' } as unknown as EnvironmentAsset;
    const rev1 = provider.publish(dummyAsset1);
    expect(rev1).toBe(1);
    expect(provider.current()).toBe(dummyAsset1);
    expect(provider.lastGood()).toBe(dummyAsset1);

    const dummyAsset2 = { assetId: 'env.2' } as unknown as EnvironmentAsset;
    const rev2 = provider.publish(dummyAsset2);
    expect(rev2).toBe(2);
    expect(provider.current()).toBe(dummyAsset2);
    expect(provider.lastGood()).toBe(dummyAsset1); // Previous asset retained as lastGood
  });

  it('reads cooked environment package from VFS and verifies integrity', async () => {
    // Cook a smoke fixture
    const fixture = createConstantHdrFixture(32, 16, [1.0, 1.0, 1.0]);
    const canonicalSource = {
      width: fixture.width,
      height: fixture.height,
      pixels: fixture.data,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 50 }
    };
    const cooked = cookEnvironmentPanorama(canonicalSource, DEFAULT_COOK_RECIPES['smoke-v1']);

    // Set up in-memory VFS provider
    const files = new Map<string, Uint8Array>();
    files.set(
      'environment.manifest.json',
      new TextEncoder().encode(serializeEnvironmentManifest(cooked.environmentArtifact))
    );
    files.set(`blobs/${cooked.environmentArtifact.irradiance.blobHash}.bin`, cooked.irradianceBlob);
    files.set(`blobs/${cooked.environmentArtifact.radiance.blobHash}.bin`, cooked.radianceBlob);
    files.set(
      'brdf-lut/lut.manifest.json',
      new TextEncoder().encode(serializeBrdfLutManifest(cooked.brdfLutArtifact))
    );
    files.set(`brdf-lut/blobs/${cooked.brdfLutArtifact.payload.blobHash}.bin`, cooked.brdfLutBlob);

    const vfs = new VirtualFileSystem();
    const mockProvider = {
      id: 'mock-memory-provider' as any,
      capabilities: { read: true },
      async read(path: string) {
        const cleanPath = path.replace(/^\/+/, '');
        const bytes = files.get(cleanPath);
        if (!bytes) {
          return { kind: 'not-found' as const, code: 'vfs-file-not-found', message: 'Not found' };
        }
        return {
          kind: 'success' as const,
          bytes,
          resolvedUri: `asset://studio/${cleanPath}` as any,
          revision: '1',
          contentLength: bytes.byteLength,
          providerId: 'mock-memory-provider' as any
        };
      }
    };

    const studioRoot = normalizeVFSUri('asset://studio');
    vfs.mount({
      scheme: parseCanonicalVFSUri(studioRoot).scheme,
      root: studioRoot,
      primary: mockProvider as any,
      caches: [],
      policy: { consultCaches: false, fallbackOn: [] }
    });

    const handle = createAssetHandle(EnvironmentAssetType, 'asset.studio');
    const asset = await readEnvironmentFromVfs({
      vfs,
      baseUri: 'asset://studio',
      handle
    });

    expect(asset.assetId).toBe('asset.studio');
    expect(asset.artifact.schema).toBe('EnvironmentArtifact@1');
    expect(asset.irradianceBytes.byteLength).toBe(cooked.irradianceBlob.byteLength);
    expect(asset.radianceBytes.byteLength).toBe(cooked.radianceBlob.byteLength);
    expect(asset.brdfLutBytes.byteLength).toBe(cooked.brdfLutBlob.byteLength);
  });
});

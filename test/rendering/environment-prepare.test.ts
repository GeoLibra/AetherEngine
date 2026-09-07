import { describe, expect, it } from 'vitest';
import { NullDevice } from '../../src';
import {
  EnvironmentTextureCache,
  getSharedBrdfLutSampler,
  getSharedEnvironmentSampler
} from '../../src/rendering/lighting/environment';
import { cookEnvironmentPanorama, DEFAULT_COOK_RECIPES } from '../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../benchmark/environment-cook/fixtures';
import type { EnvironmentAsset } from '../../src/assets/environment';

describe('Environment GPU texture cache, leases, and surface resize decoupling', () => {
  it('creates dedicated samplers with repeat-U for environment and clamp-to-edge for BRDF LUT', () => {
    const device = new NullDevice();
    const envSampler = getSharedEnvironmentSampler(device);
    const brdfSampler = getSharedBrdfLutSampler(device);

    expect(envSampler).toBeDefined();
    expect(brdfSampler).toBeDefined();
    expect(envSampler).not.toBe(brdfSampler);

    // Singleton per device
    expect(getSharedEnvironmentSampler(device)).toBe(envSampler);
    expect(getSharedBrdfLutSampler(device)).toBe(brdfSampler);
  });

  it('prepares and caches environment textures on device with lease tracking', () => {
    const fixture = createConstantHdrFixture(32, 16, [1.0, 1.0, 1.0]);
    const canonicalSource = {
      width: fixture.width,
      height: fixture.height,
      pixels: fixture.data,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 50 }
    };
    const cooked = cookEnvironmentPanorama(canonicalSource, DEFAULT_COOK_RECIPES['smoke-v1']);

    const asset: EnvironmentAsset = {
      assetId: 'asset.smoke' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    // First acquire uploads textures
    const bundle1 = cache.acquire(device, asset);
    expect(bundle1.textures.irradianceMap).toBeDefined();
    expect(bundle1.textures.prefilteredRadianceMap).toBeDefined();
    expect(bundle1.textures.environmentBrdfLut).toBeDefined();
    expect(cache.uploadByteCounter).toBeGreaterThan(0);
    const initialUploadBytes = cache.uploadByteCounter;
    const initialUploadCommands = cache.uploadCommandCounter;

    // Second acquire (e.g. from another view or surface resize on same device)
    const bundle2 = cache.acquire(device, asset);
    expect(bundle2.textures.irradianceMap).toBe(bundle1.textures.irradianceMap);
    expect(bundle2.textures.prefilteredRadianceMap).toBe(bundle1.textures.prefilteredRadianceMap);
    expect(bundle2.textures.environmentBrdfLut).toBe(bundle1.textures.environmentBrdfLut);

    // Invariant: Zero extra uploads on reuse
    expect(cache.uploadByteCounter).toBe(initialUploadBytes);
    expect(cache.uploadCommandCounter).toBe(initialUploadCommands);

    // Releasing first lease keeps textures alive
    bundle1.release();
    expect(bundle2.textures.irradianceMap.state).toBe('live');

    // Releasing final lease disposes textures
    bundle2.release();
    expect(bundle2.textures.irradianceMap.state).toBe('disposed');
  });

  it('decouples surface resize from environment texture uploads', () => {
    const fixture = createConstantHdrFixture(32, 16, [1.0, 1.0, 1.0]);
    const canonicalSource = {
      width: fixture.width,
      height: fixture.height,
      pixels: fixture.data,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 50 }
    };
    const cooked = cookEnvironmentPanorama(canonicalSource, DEFAULT_COOK_RECIPES['smoke-v1']);

    const asset: EnvironmentAsset = {
      assetId: 'asset.smoke' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    // Initial acquire for View 1
    const bundle = cache.acquire(device, asset);
    const recordedUploadBytes = cache.uploadByteCounter;

    // Simulating multiple surface resizes (e.g. window dragged, canvas resized 5 times)
    for (let i = 0; i < 5; i++) {
      // On resize: view state/bindings reacquire environment textures from cache
      const reacquired = cache.acquire(device, asset);
      expect(reacquired.textures.irradianceMap).toBe(bundle.textures.irradianceMap);
      reacquired.release();
    }

    // Invariant: Upload byte counter must NOT increase across surface resizes
    expect(cache.uploadByteCounter).toBe(recordedUploadBytes);

    bundle.release();
  });
});

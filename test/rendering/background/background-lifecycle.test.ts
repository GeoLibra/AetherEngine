import { describe, expect, it } from 'vitest';
import { NullDevice } from '../../../src';
import { EnvironmentTextureCache } from '../../../src/rendering/lighting/environment/environment-cache';
import {
  cookEnvironmentPanorama,
  cookEnvironmentPanoramaV2,
  DEFAULT_COOK_RECIPES
} from '../../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../../benchmark/environment-cook/fixtures';
import type { EnvironmentAsset } from '../../../src/assets/environment';
import type { RHISubmission } from '../../../src/rhi';
import {
  clearBackgroundPipelineCache,
  prepareBackground,
  prepareBackgroundPipeline
} from '../../../src/rendering/background';
import type { ExtractedView } from '../../../src/rendering/camera';

describe('background selective residency, complete key identity, and submission-safe retirement', () => {
  const fixture = createConstantHdrFixture(32, 16, [1.0, 1.0, 1.0]);
  const canonicalSource = {
    width: fixture.width,
    height: fixture.height,
    pixels: fixture.data,
    metadata: { format: '32-bit_rle_rgbe' as const, rawHeaderBytes: 50 }
  };

  it('selectively allocates background panorama without uploading irradiance or LUT', () => {
    const cooked = cookEnvironmentPanoramaV2(
      canonicalSource,
      DEFAULT_COOK_RECIPES['smoke-v1'],
      true
    );
    const asset: EnvironmentAsset = {
      assetId: 'asset.smoke.v2' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob,
      panoramaBytes: cooked.panoramaBlob
    } as unknown as EnvironmentAsset;

    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    // Background-only acquire
    const bgBundle = cache.acquireBackground(device, asset, 'panorama');
    expect(bgBundle.texture).toBeDefined();
    expect(bgBundle.representation).toBe('panorama');
    expect(bgBundle.maxLod).toBeGreaterThan(0);

    const bgUploadBytes = cache.uploadByteCounter;
    expect(bgUploadBytes).toBeGreaterThan(0);

    // IBL should NOT have been uploaded
    // Acquiring IBL now triggers additional uploads for irradiance, radiance, lut
    const iblBundle = cache.acquire(device, asset);
    expect(cache.uploadByteCounter).toBeGreaterThan(bgUploadBytes);

    bgBundle.release();
    iblBundle.release();
  });

  it('defers texture destruction until pending GPU submission completes', async () => {
    const cooked = cookEnvironmentPanoramaV2(
      canonicalSource,
      DEFAULT_COOK_RECIPES['smoke-v1'],
      true
    );
    const asset: EnvironmentAsset = {
      assetId: 'asset.smoke.v2' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob,
      panoramaBytes: cooked.panoramaBlob
    } as unknown as EnvironmentAsset;

    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    const bgBundle = cache.acquireBackground(device, asset, 'panorama');
    const texture = bgBundle.texture;
    expect(texture.state).toBe('live');

    let resolveSubmission!: (res: any) => void;
    const subPromise = new Promise((resolve) => {
      resolveSubmission = resolve;
    });

    const submission: RHISubmission = {
      id: 1,
      status: 'pending',
      done: subPromise as any
    };

    // Retain with pending submission
    bgBundle.retain(submission);

    // Release caller lease
    bgBundle.release();

    // Invariant: Texture must still be live because submission is pending!
    expect(texture.state).toBe('live');

    // Complete the submission
    resolveSubmission({ status: 'completed' });
    await subPromise;
    await Promise.resolve();

    // Now texture should be disposed
    expect(texture.state).toBe('disposed');
  });

  it('throws background-panorama-unavailable when panorama is missing from artifact', () => {
    const cooked = cookEnvironmentPanorama(canonicalSource, DEFAULT_COOK_RECIPES['smoke-v1']);
    const assetV1: EnvironmentAsset = {
      assetId: 'asset.smoke.v1' as any,
      artifact: cooked.environmentArtifact, // @1 has no background
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    expect(() => cache.acquireBackground(device, assetV1, 'panorama')).toThrow(
      /background-panorama-unavailable/
    );
  });

  const mockView = {
    viewId: 'test-view',
    view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    projectionKind: 'perspective' as const,
    depthMode: 'standard' as const,
    cameraEntity: 1 as any,
    layerMask: 1
  } as unknown as ExtractedView;

  it('caches static background pipeline and purges cache across device generations', () => {
    const device1 = new NullDevice();
    const p1 = prepareBackgroundPipeline(device1, {
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus'
    });
    const p2 = prepareBackgroundPipeline(device1, {
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus'
    });
    expect(p1.prepared.pipeline).toBe(p2.prepared.pipeline);
    expect(p1.prepared.uniformLayout).toBe(p2.prepared.uniformLayout);

    // New device instance has a different generation, purging old cache
    const device2 = new NullDevice();
    const p3 = prepareBackgroundPipeline(device2, {
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus'
    });
    expect(p3.prepared.pipeline).not.toBe(p1.prepared.pipeline);

    clearBackgroundPipelineCache();
  });

  it('retains uniform buffer until GPU submission completes and disposes immediately if un-retained', async () => {
    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();

    // 1. Released without retention -> disposed immediately
    const prep1 = prepareBackground({
      device,
      view: mockView,
      background: { kind: 'solid', colorLinear: [1, 0, 0] },
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      environmentCache: cache
    });
    if (prep1.status !== 'ready') throw new Error('Expected ready');
    const u1 = prep1.uniformBuffer!;
    expect(u1).toBeDefined();
    expect(u1.state).toBe('live');
    prep1.release();
    expect(u1.state).toBe('disposed');

    // 2. Retained with submission -> kept live until submission finishes
    const prep2 = prepareBackground({
      device,
      view: mockView,
      background: { kind: 'solid', colorLinear: [0, 1, 0] },
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      environmentCache: cache
    });
    if (prep2.status !== 'ready') throw new Error('Expected ready');
    const u2 = prep2.uniformBuffer!;
    expect(u2).toBeDefined();
    expect(u2.state).toBe('live');

    let resolveSubmission!: () => void;
    const subPromise = new Promise<void>((r) => {
      resolveSubmission = r;
    });
    prep2.retain({ id: 1, status: 'pending', done: subPromise as any });
    prep2.release();
    expect(u2.state).toBe('live');

    resolveSubmission();
    await subPromise;
    await Promise.resolve();
    expect(u2.state).toBe('disposed');
  });

  it('throws background-composition-invalid when background kind is inherit', () => {
    const device = new NullDevice();
    const cache = new EnvironmentTextureCache();
    expect(() =>
      prepareBackground({
        device,
        view: mockView,
        background: { kind: 'inherit' },
        colorFormat: 'rgba16float',
        depthFormat: 'depth24plus',
        environmentCache: cache
      })
    ).toThrow(/background-composition-invalid/);
  });
});

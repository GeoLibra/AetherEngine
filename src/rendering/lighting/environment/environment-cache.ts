/**
 * @file Device-scoped environment texture cache and lifecycle lease tracker.
 * Decouples GPU texture allocations from surface resize and view lifecycle.
 * Provides submission-safe retirement and selective residency for IBL and Skybox.
 */

import type { RHIDevice, RHISubmission, RHITexture } from '../../../rhi';
import type { EnvironmentAsset } from '../../../assets/environment';
import type { EnvironmentTextureSet } from './default-environment';
import { SubmissionRetainedValue } from '../../world/submission-retained-value';
import { BackgroundDiagnosticError } from '../../background/diagnostics';
import type { PreparedBackgroundBundle } from '../../background/types';

const SAMPLED_COPY_DST_TEXTURE_USAGE = (1 << 1) | (1 << 2);

interface CachedIblEntry {
  readonly textures: EnvironmentTextureSet;
  readonly maxValidRadianceLod: number;
  readonly retention: SubmissionRetainedValue<EnvironmentTextureSet>;
  leaseCount: number;
}

interface CachedBackgroundEntry {
  readonly texture: RHITexture;
  readonly maxLod: number;
  readonly representation: 'panorama' | 'radiance-level-zero';
  readonly retention: SubmissionRetainedValue<RHITexture>;
  leaseCount: number;
}

export interface PreparedEnvironmentBundle {
  readonly textures: EnvironmentTextureSet;
  readonly maxValidRadianceLod: number;
  readonly blobHash: string;
  readonly device: RHIDevice;
  retain(submission?: RHISubmission): void;
  release(): void;
}

export { type PreparedBackgroundBundle } from '../../background/types';

/**
 * Cache managing GPU environment texture allocations scoped to an RHIDevice.
 *
 * Invariants:
 * 1. Textures are retained as long as at least one lease is active or a GPU submission is pending.
 * 2. Surface resize/reconfigure does not invalidate cached textures or trigger uploads.
 * 3. Destroying the device or disposing the cache cleans up all allocated textures safely.
 */
export class EnvironmentTextureCache {
  private readonly deviceIblCaches = new WeakMap<RHIDevice, Map<string, CachedIblEntry>>();
  private readonly deviceBgCaches = new WeakMap<RHIDevice, Map<string, CachedBackgroundEntry>>();
  public uploadByteCounter = 0;
  public uploadCommandCounter = 0;

  /**
   * Acquires or prepares IBL GPU textures for the given canonical EnvironmentAsset.
   */
  acquire(device: RHIDevice, asset: EnvironmentAsset): PreparedEnvironmentBundle {
    let cache = this.deviceIblCaches.get(device);
    if (cache === undefined) {
      cache = new Map<string, CachedIblEntry>();
      this.deviceIblCaches.set(device, cache);
    }

    const key = computeIblBundleKey(device, asset);
    const existing = cache.get(key);

    if (existing !== undefined) {
      const lease = existing.retention.acquire();
      if (lease !== undefined) {
        existing.leaseCount += 1;
        let released = false;

        return Object.freeze({
          textures: existing.textures,
          maxValidRadianceLod: existing.maxValidRadianceLod,
          blobHash: asset.artifact.radiance.blobHash,
          device,
          retain: (sub?: RHISubmission) => {
            if (sub) lease.retain(sub);
          },
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            existing.leaseCount -= 1;
            if (existing.leaseCount <= 0) {
              existing.retention.retire();
              cache?.delete(key);
            }
          }
        });
      }
    }

    // Prepare and upload new GPU textures
    const entry = this.uploadEnvironmentTextures(device, asset);
    cache.set(key, entry);

    const lease = entry.retention.acquire()!;
    let released = false;

    return Object.freeze({
      textures: entry.textures,
      maxValidRadianceLod: entry.maxValidRadianceLod,
      blobHash: asset.artifact.radiance.blobHash,
      device,
      retain: (sub?: RHISubmission) => {
        if (sub) lease.retain(sub);
      },
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        entry.leaseCount -= 1;
        if (entry.leaseCount <= 0) {
          entry.retention.retire();
          cache?.delete(key);
        }
      }
    });
  }

  /**
   * Acquires or prepares background texture for the given canonical EnvironmentAsset.
   */
  acquireBackground(
    device: RHIDevice,
    asset: EnvironmentAsset,
    representation: 'panorama' | 'radiance-level-zero'
  ): PreparedBackgroundBundle {
    let cache = this.deviceBgCaches.get(device);
    if (cache === undefined) {
      cache = new Map<string, CachedBackgroundEntry>();
      this.deviceBgCaches.set(device, cache);
    }

    const key = computeBackgroundBundleKey(device, asset, representation);
    const existing = cache.get(key);

    if (existing !== undefined) {
      const lease = existing.retention.acquire();
      if (lease !== undefined) {
        existing.leaseCount += 1;
        let released = false;

        return Object.freeze({
          texture: existing.texture,
          maxLod: existing.maxLod,
          representation,
          blobHash: key,
          retain: (sub?: RHISubmission) => {
            if (sub) lease.retain(sub);
          },
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            existing.leaseCount -= 1;
            if (existing.leaseCount <= 0) {
              existing.retention.retire();
              cache?.delete(key);
            }
          }
        });
      }
    }

    // Upload background texture
    const entry = this.uploadBackgroundTexture(device, asset, representation);
    cache.set(key, entry);

    const lease = entry.retention.acquire()!;
    let released = false;

    return Object.freeze({
      texture: entry.texture,
      maxLod: entry.maxLod,
      representation,
      blobHash: key,
      retain: (sub?: RHISubmission) => {
        if (sub) lease.retain(sub);
      },
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        entry.leaseCount -= 1;
        if (entry.leaseCount <= 0) {
          entry.retention.retire();
          cache?.delete(key);
        }
      }
    });
  }

  private uploadEnvironmentTextures(device: RHIDevice, asset: EnvironmentAsset): CachedIblEntry {
    const { artifact, irradianceBytes, radianceBytes, brdfLutBytes } = asset;
    const irrLevel = artifact.irradiance.levels[0]!;

    // 1. Irradiance map
    const irradianceMap = device.createTexture({
      label: 'aether-ibl-irradiance',
      size: [irrLevel.width, irrLevel.height],
      format: 'rgba16float',
      usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
      mipLevelCount: 1
    });

    device.queue.writeTexture(
      { texture: irradianceMap, mipLevel: 0 },
      irradianceBytes,
      { bytesPerRow: irrLevel.width * 8, rowsPerImage: irrLevel.height },
      { width: irrLevel.width, height: irrLevel.height }
    );
    this.uploadByteCounter += irradianceBytes.byteLength;
    this.uploadCommandCounter += 1;

    // 2. Prefiltered radiance mip chain
    const radLevels = artifact.radiance.levels;
    const baseMip = radLevels[0]!;
    const prefilteredRadianceMap = device.createTexture({
      label: 'aether-ibl-radiance',
      size: [baseMip.width, baseMip.height],
      format: 'rgba16float',
      usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
      mipLevelCount: radLevels.length
    });

    for (const lvl of radLevels) {
      const levelSlice = radianceBytes.subarray(lvl.byteOffset, lvl.byteOffset + lvl.byteLength);
      device.queue.writeTexture(
        { texture: prefilteredRadianceMap, mipLevel: lvl.level },
        levelSlice,
        { bytesPerRow: lvl.width * 8, rowsPerImage: lvl.height },
        { width: lvl.width, height: lvl.height }
      );
      this.uploadByteCounter += lvl.byteLength;
      this.uploadCommandCounter += 1;
    }

    // 3. BRDF LUT
    const lutLevel = asset.brdfLutArtifact.payload.levels[0]!;
    const environmentBrdfLut = device.createTexture({
      label: 'aether-ibl-brdf-lut',
      size: [lutLevel.width, lutLevel.height],
      format: 'rgba16float',
      usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
      mipLevelCount: 1
    });

    device.queue.writeTexture(
      { texture: environmentBrdfLut, mipLevel: 0 },
      brdfLutBytes,
      { bytesPerRow: lutLevel.width * 8, rowsPerImage: lutLevel.height },
      { width: lutLevel.width, height: lutLevel.height }
    );
    this.uploadByteCounter += brdfLutBytes.byteLength;
    this.uploadCommandCounter += 1;

    const textures = Object.freeze({
      irradianceMap,
      prefilteredRadianceMap,
      environmentBrdfLut
    });

    const retention = new SubmissionRetainedValue<EnvironmentTextureSet>(
      textures,
      disposeIblTextures
    );

    return {
      textures,
      maxValidRadianceLod: artifact.maxValidRadianceLod,
      retention,
      leaseCount: 1
    };
  }

  private uploadBackgroundTexture(
    device: RHIDevice,
    asset: EnvironmentAsset,
    representation: 'panorama' | 'radiance-level-zero'
  ): CachedBackgroundEntry {
    if (representation === 'panorama') {
      if (
        asset.artifact.schema !== 'EnvironmentArtifact@2' ||
        asset.artifact.background.kind !== 'panorama' ||
        !asset.panoramaBytes
      ) {
        throw new BackgroundDiagnosticError(
          'background-panorama-unavailable',
          'Selected panorama background is not available in the environment asset.'
        );
      }

      const payload = asset.artifact.background.payload;
      const baseMip = payload.levels[0]!;
      const texture = device.createTexture({
        label: 'aether-skybox-panorama',
        size: [baseMip.width, baseMip.height],
        format: 'rgba16float',
        usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
        mipLevelCount: payload.levels.length
      });

      for (const lvl of payload.levels) {
        const slice = asset.panoramaBytes.subarray(lvl.byteOffset, lvl.byteOffset + lvl.byteLength);
        device.queue.writeTexture(
          { texture, mipLevel: lvl.level },
          slice,
          { bytesPerRow: lvl.width * 8, rowsPerImage: lvl.height },
          { width: lvl.width, height: lvl.height }
        );
        this.uploadByteCounter += lvl.byteLength;
        this.uploadCommandCounter += 1;
      }

      const maxLod = payload.levels.length - 1;
      const retention = new SubmissionRetainedValue<RHITexture>(texture, (t) => t.dispose());

      return {
        texture,
        maxLod,
        representation: 'panorama',
        retention,
        leaseCount: 1
      };
    }

    // radiance-level-zero mode: upload level 0 only of radiance
    const lvl0 = asset.artifact.radiance.levels[0]!;
    const texture = device.createTexture({
      label: 'aether-skybox-radiance-level0',
      size: [lvl0.width, lvl0.height],
      format: 'rgba16float',
      usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
      mipLevelCount: 1
    });

    const slice = asset.radianceBytes.subarray(lvl0.byteOffset, lvl0.byteOffset + lvl0.byteLength);
    device.queue.writeTexture(
      { texture, mipLevel: 0 },
      slice,
      { bytesPerRow: lvl0.width * 8, rowsPerImage: lvl0.height },
      { width: lvl0.width, height: lvl0.height }
    );
    this.uploadByteCounter += lvl0.byteLength;
    this.uploadCommandCounter += 1;

    const retention = new SubmissionRetainedValue<RHITexture>(texture, (t) => t.dispose());

    return {
      texture,
      maxLod: 0,
      representation: 'radiance-level-zero',
      retention,
      leaseCount: 1
    };
  }

  /**
   * Disposes all textures allocated for the given device.
   */
  disposeDevice(device: RHIDevice): void {
    const iblCache = this.deviceIblCaches.get(device);
    if (iblCache !== undefined) {
      for (const entry of iblCache.values()) {
        entry.retention.retire();
      }
      iblCache.clear();
    }

    const bgCache = this.deviceBgCaches.get(device);
    if (bgCache !== undefined) {
      for (const entry of bgCache.values()) {
        entry.retention.retire();
      }
      bgCache.clear();
    }
  }
}

function computeIblBundleKey(device: RHIDevice, asset: EnvironmentAsset): string {
  return `${device.generation}|${asset.artifact.schema}|rad:${asset.artifact.radiance.blobHash}|irr:${asset.artifact.irradiance.blobHash}|lut:${asset.artifact.brdfLut.contentHash}`;
}

function computeBackgroundBundleKey(
  device: RHIDevice,
  asset: EnvironmentAsset,
  representation: 'panorama' | 'radiance-level-zero'
): string {
  if (representation === 'panorama') {
    const bgHash =
      asset.artifact.schema === 'EnvironmentArtifact@2' &&
      asset.artifact.background.kind === 'panorama'
        ? asset.artifact.background.payload.blobHash
        : 'missing';
    return `${device.generation}|panorama:${bgHash}`;
  }
  return `${device.generation}|rad0:${asset.artifact.radiance.blobHash}`;
}

function disposeIblTextures(textures: EnvironmentTextureSet): void {
  textures.irradianceMap.dispose();
  textures.prefilteredRadianceMap.dispose();
  textures.environmentBrdfLut.dispose();
}

/** Shared singleton instance for device-scoped environment texture caching. */
export const sharedEnvironmentTextureCache = new EnvironmentTextureCache();

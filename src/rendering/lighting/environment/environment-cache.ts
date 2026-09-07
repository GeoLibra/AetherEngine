/**
 * @file Device-scoped environment texture cache and lifecycle lease tracker.
 * Decouples GPU texture allocations from surface resize and view lifecycle.
 */

import type { RHIDevice, RHITexture } from '../../../rhi';
import type { EnvironmentAsset } from '../../../assets/environment';
import type { EnvironmentTextureSet } from './default-environment';

const SAMPLED_COPY_DST_TEXTURE_USAGE = (1 << 1) | (1 << 2);

interface CachedTextureEntry {
  readonly textures: EnvironmentTextureSet;
  readonly maxValidRadianceLod: number;
  leaseCount: number;
}

export interface PreparedEnvironmentBundle {
  readonly textures: EnvironmentTextureSet;
  readonly maxValidRadianceLod: number;
  readonly blobHash: string;
  readonly device: RHIDevice;
  release(): void;
}

/**
 * Cache managing GPU environment texture allocations scoped to an RHIDevice.
 *
 * Invariants:
 * 1. Textures are retained as long as at least one lease is active.
 * 2. Surface resize/reconfigure does not invalidate cached textures or trigger uploads.
 * 3. Destroying the device or disposing the cache cleans up all allocated textures.
 */
export class EnvironmentTextureCache {
  private readonly deviceCaches = new WeakMap<RHIDevice, Map<string, CachedTextureEntry>>();
  public uploadByteCounter = 0;
  public uploadCommandCounter = 0;

  /**
   * Acquires or prepares GPU textures for the given canonical EnvironmentAsset.
   */
  acquire(device: RHIDevice, asset: EnvironmentAsset): PreparedEnvironmentBundle {
    let cache = this.deviceCaches.get(device);
    if (cache === undefined) {
      cache = new Map<string, CachedTextureEntry>();
      this.deviceCaches.set(device, cache);
    }

    const key = asset.artifact.radiance.blobHash;
    const existing = cache.get(key);

    if (existing !== undefined) {
      existing.leaseCount += 1;
      let released = false;

      return Object.freeze({
        textures: existing.textures,
        maxValidRadianceLod: existing.maxValidRadianceLod,
        blobHash: key,
        device,
        release: () => {
          if (released) return;
          released = true;
          existing.leaseCount -= 1;
          if (existing.leaseCount <= 0) {
            this.disposeEntry(existing);
            cache?.delete(key);
          }
        }
      });
    }

    // Prepare and upload new GPU textures
    const entry = this.uploadEnvironmentTextures(device, asset);
    cache.set(key, entry);

    let released = false;
    return Object.freeze({
      textures: entry.textures,
      maxValidRadianceLod: entry.maxValidRadianceLod,
      blobHash: key,
      device,
      release: () => {
        if (released) return;
        released = true;
        entry.leaseCount -= 1;
        if (entry.leaseCount <= 0) {
          this.disposeEntry(entry);
          cache?.delete(key);
        }
      }
    });
  }

  private uploadEnvironmentTextures(
    device: RHIDevice,
    asset: EnvironmentAsset
  ): CachedTextureEntry {
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

    return {
      textures: Object.freeze({
        irradianceMap,
        prefilteredRadianceMap,
        environmentBrdfLut
      }),
      maxValidRadianceLod: artifact.maxValidRadianceLod,
      leaseCount: 1
    };
  }

  private disposeEntry(entry: CachedTextureEntry): void {
    entry.textures.irradianceMap.dispose();
    entry.textures.prefilteredRadianceMap.dispose();
    entry.textures.environmentBrdfLut.dispose();
  }

  /**
   * Disposes all textures allocated for the given device.
   */
  disposeDevice(device: RHIDevice): void {
    const cache = this.deviceCaches.get(device);
    if (cache !== undefined) {
      for (const entry of cache.values()) {
        this.disposeEntry(entry);
      }
      cache.clear();
    }
  }
}

/** Shared singleton instance for device-scoped environment texture caching. */
export const sharedEnvironmentTextureCache = new EnvironmentTextureCache();

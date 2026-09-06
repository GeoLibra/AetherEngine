import type { RHIDevice, RHISampler, RHITexture } from '../../../rhi';
import { getSharedEnvironmentBrdfLut } from './environment-brdf-lut';

const SAMPLED_COPY_DST_TEXTURE_USAGE = (1 << 1) | (1 << 2);

const samplerDeviceCache = new WeakMap<RHIDevice, RHISampler>();

/**
 * Creates or retrieves a device-scoped singleton texture sampler configured for
 * environment map sampling (bilinear filtering with clamp-to-edge wrap mode).
 *
 * @param device - Active RHI device.
 * @returns Cached or newly created RHI sampler.
 */
export function getSharedEnvironmentSampler(device: RHIDevice): RHISampler {
  const existing = samplerDeviceCache.get(device);
  if (existing !== undefined && existing.state === 'live') {
    return existing;
  }

  const sampler = device.createSampler({
    label: 'aether-environment-sampler',
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge'
  });

  samplerDeviceCache.set(device, sampler);
  return sampler;
}

/**
 * Generates synthetic linear sRGB environment pixels for deterministic fallback IBL.
 *
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param energy - Overall radiant energy scaling factor.
 * @returns Byte array with packed RGBA8 texels.
 */
export function generateSyntheticEnvironmentPixels(
  width: number,
  height: number,
  energy: number
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const horizon = 1 - Math.abs(((y + 0.5) / height) * 2 - 1);
      const warmKey = Math.max(0, Math.cos(((x + 0.5) / width - 0.2) * Math.PI * 2));
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(255 * energy * (0.22 + warmKey * 0.55));
      pixels[offset + 1] = Math.round(255 * energy * (0.3 + horizon * 0.5));
      pixels[offset + 2] = Math.round(255 * energy * (0.48 + horizon * 0.45));
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Immutable bundle of textures providing standard image-based lighting inputs.
 */
export interface EnvironmentTextureSet {
  readonly irradianceMap: RHITexture;
  readonly prefilteredRadianceMap: RHITexture;
  readonly environmentBrdfLut: RHITexture;
}

/**
 * Creates deterministic baseline environment textures fulfilling the IBL shader contract.
 *
 * Invariant:
 * The `environmentBrdfLut` entry is reused from the device-level shared cache via
 * `getSharedEnvironmentBrdfLut`, avoiding redundant GPU texture allocations.
 *
 * @param device - Active RHI device.
 * @returns Readonly bundle containing irradiance, prefiltered radiance, and BRDF LUT textures.
 */
export function createDefaultEnvironmentTextures(device: RHIDevice): EnvironmentTextureSet {
  const createTexture = (label: string, width: number, height: number, mipLevelCount: number) =>
    device.createTexture({
      label,
      size: [width, height],
      format: 'rgba8unorm',
      usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
      mipLevelCount
    });

  const irradiance = createTexture('aether-baseline-ibl-irradiance', 8, 4, 1);
  const radiance = createTexture('aether-baseline-ibl-radiance', 8, 4, 3);
  const brdfLut = getSharedEnvironmentBrdfLut(device);

  try {
    uploadRgba8Texture(device, irradiance, 0, 8, 4, generateSyntheticEnvironmentPixels(8, 4, 0.35));

    for (let mip = 0; mip < 3; mip += 1) {
      const width = Math.max(1, 8 >> mip);
      const height = Math.max(1, 4 >> mip);
      const energy = 1 - mip * 0.22;
      uploadRgba8Texture(
        device,
        radiance,
        mip,
        width,
        height,
        generateSyntheticEnvironmentPixels(width, height, energy)
      );
    }

    return Object.freeze({
      irradianceMap: irradiance,
      prefilteredRadianceMap: radiance,
      environmentBrdfLut: brdfLut
    });
  } catch (error) {
    irradiance.dispose();
    radiance.dispose();
    throw error;
  }
}

function uploadRgba8Texture(
  device: RHIDevice,
  texture: RHITexture,
  mipLevel: number,
  width: number,
  height: number,
  pixels: Uint8Array
): void {
  device.queue.writeTexture(
    { texture, mipLevel },
    pixels,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height }
  );
}

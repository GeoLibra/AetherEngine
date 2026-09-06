import type { RHIDevice, RHITexture } from '../../../rhi';

/** Default dimension for the square environment BRDF 2D lookup table (64x64). */
export const ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE = 64;

const SAMPLED_COPY_DST_TEXTURE_USAGE = (1 << 1) | (1 << 2);

const brdfLutDeviceCache = new WeakMap<RHIDevice, RHITexture>();

/**
 * Computes a standard Cook-Torrance GGX specular BRDF 2D integration table (Scale and Bias)
 * as an RGBA8 byte buffer using the Lazarov / Karis polynomial fit approximation.
 *
 * Coordinates:
 * - Horizontal axis (X): \( N \cdot V \) cosine in \([0, 1]\).
 * - Vertical axis (Y): Roughness in \([0, 1]\).
 *
 * Channels:
 * - R (Red): Fresnel-Schlick scale factor (\( F_0 \) multiplier).
 * - G (Green): Fresnel-Schlick bias factor (\( F_0 \) offset).
 * - B (Blue): Zero (reserved for future directional albedo multi-scattering compensation).
 * - A (Alpha): 255 (normalized 1.0, reserved for future sheen/clearcoat factor).
 *
 * @param width - Horizontal resolution in texels. Defaults to 64.
 * @param height - Vertical resolution in texels. Defaults to 64.
 * @returns Byte array with packed RGBA8 texels.
 */
export function generateEnvironmentBrdfLutData(
  width = ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE,
  height = ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const c0 = [-1.0, -0.0275, -0.572, 0.022];
  const c1 = [1.0, 0.0425, 1.04, -0.04];

  for (let y = 0; y < height; y += 1) {
    const roughness = (y + 0.5) / height;
    const rX = roughness * c0[0]! + c1[0]!;
    const rY = roughness * c0[1]! + c1[1]!;
    const rZ = roughness * c0[2]! + c1[2]!;
    const rW = roughness * c0[3]! + c1[3]!;

    for (let x = 0; x < width; x += 1) {
      const normalDotView = (x + 0.5) / width;
      const offset = (y * width + x) * 4;

      const a004 = Math.min(rX * rX, Math.pow(2.0, -9.28 * normalDotView)) * rX + rY;
      const scale = Math.min(Math.max(-1.04 * a004 + rZ, 0.0), 1.0);
      const bias = Math.min(Math.max(1.04 * a004 + rW, 0.0), 1.0);

      pixels[offset] = Math.round(scale * 255);
      pixels[offset + 1] = Math.round(bias * 255);
      pixels[offset + 2] = 0;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

/**
 * Retrieves or creates a device-scoped singleton 2D texture containing the precomputed
 * environment BRDF LUT.
 *
 * Invariant:
 * The resulting texture is cached in a `WeakMap` by `RHIDevice` identity, guaranteeing
 * that only one instance of the BRDF LUT texture resides in GPU memory per active device.
 *
 * @param device - Active RHI device.
 * @param size - Resolution in texels (square). Defaults to 64.
 * @returns Cached or newly initialized RHI texture with `rgba8unorm` format.
 */
export function getSharedEnvironmentBrdfLut(
  device: RHIDevice,
  size = ENVIRONMENT_BRDF_LUT_DEFAULT_SIZE
): RHITexture {
  const existing = brdfLutDeviceCache.get(device);
  if (existing !== undefined && existing.state === 'live') {
    return existing;
  }

  const texture = device.createTexture({
    label: 'aether-environment-brdf-lut',
    size: [size, size],
    format: 'rgba8unorm',
    usage: SAMPLED_COPY_DST_TEXTURE_USAGE,
    mipLevelCount: 1
  });

  const pixels = generateEnvironmentBrdfLutData(size, size);
  device.queue.writeTexture(
    { texture, mipLevel: 0 },
    pixels,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size }
  );

  brdfLutDeviceCache.set(device, texture);
  return texture;
}

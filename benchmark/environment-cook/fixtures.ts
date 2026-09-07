/**
 * @file Analytic HDR test fixtures for environment IBL cook tests and benchmarks.
 * Generates floating-point scene-linear equirectangular panoramas with exact properties.
 */

export interface Float32HdrImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array; // Row-major RGB Float32 (3 * width * height)
}

/**
 * Creates an immutable Float32 HDR equirectangular image buffer.
 */
export function createHdrBuffer(width: number, height: number): Float32HdrImage {
  if (width <= 0 || height <= 0 || width % 2 !== 0) {
    throw new Error(`Invalid HDR dimensions: ${width}x${height}. Width must be positive and even.`);
  }
  const data = new Float32Array(width * height * 3);
  return { width, height, data };
}

/**
 * Creates a uniform constant-color HDR equirectangular image.
 * Invariant: Irradiance of constant radiance C is exactly pi * C.
 */
export function createConstantHdrFixture(
  width: number,
  height: number,
  color: readonly [number, number, number] = [1.0, 1.0, 1.0]
): Float32HdrImage {
  const img = createHdrBuffer(width, height);
  const [r, g, b] = color;
  for (let i = 0; i < width * height; i++) {
    const offset = i * 3;
    img.data[offset] = r;
    img.data[offset + 1] = g;
    img.data[offset + 2] = b;
  }
  return img;
}

/**
 * Creates an HDR fixture with distinct directional landmarks along cardinal axes:
 * +X (u=0.5), -X (u=0.0 / 1.0), +Y (v=0.0), -Y (v=1.0), +Z (u=0.75), -Z (u=0.25).
 */
export function createDirectionalLandmarksFixture(width: number, height: number): Float32HdrImage {
  const img = createHdrBuffer(width, height);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const offset = (y * width + x) * 3;

      // Base ambient floor
      let r = 0.05;
      let g = 0.05;
      let b = 0.05;

      // +X landmark (Red, center u=0.5, v=0.5)
      if (Math.abs(u - 0.5) < 0.05 && Math.abs(v - 0.5) < 0.1) r += 5.0;
      // +Z landmark (Blue, u=0.75, v=0.5)
      if (Math.abs(u - 0.75) < 0.05 && Math.abs(v - 0.5) < 0.1) b += 5.0;
      // -Z landmark (Green, u=0.25, v=0.5)
      if (Math.abs(u - 0.25) < 0.05 && Math.abs(v - 0.5) < 0.1) g += 5.0;
      // +Y North pole (Yellow, v < 0.08)
      if (v < 0.08) {
        r += 3.0;
        g += 3.0;
      }
      // -Y South pole (Cyan, v > 0.92)
      if (v > 0.92) {
        g += 3.0;
        b += 3.0;
      }

      img.data[offset] = r;
      img.data[offset + 1] = g;
      img.data[offset + 2] = b;
    }
  }
  return img;
}

/**
 * Creates an HDR fixture with high-frequency continuous pattern across the periodic seam (u=0 and u=1).
 */
export function createPeriodicSeamFixture(width: number, height: number): Float32HdrImage {
  const img = createHdrBuffer(width, height);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const offset = (y * width + x) * 3;
      const val = Math.cos(2 * Math.PI * u * 4) * Math.sin(Math.PI * v) * 2.0 + 2.5;
      img.data[offset] = val;
      img.data[offset + 1] = val * 0.8;
      img.data[offset + 2] = val * 0.6;
    }
  }
  return img;
}

/**
 * Creates an HDR fixture with high intensity localized at the polar cap.
 */
export function createPolarCapFixture(width: number, height: number): Float32HdrImage {
  const img = createHdrBuffer(width, height);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const isNorth = v < 0.15;
    const isSouth = v > 0.85;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      img.data[offset] = isNorth ? 10.0 : 0.1;
      img.data[offset + 1] = isSouth ? 10.0 : 0.1;
      img.data[offset + 2] = 0.1;
    }
  }
  return img;
}

/**
 * Creates an HDR fixture with a small, intense bright emitter (stress-test for importance sampling).
 */
export function createBrightEmitterFixture(
  width: number,
  height: number,
  emitterRadiance = 1000.0
): Float32HdrImage {
  const img = createHdrBuffer(width, height);
  img.data.fill(0.1);
  const targetX = Math.floor(width * 0.5);
  const targetY = Math.floor(height * 0.3);
  const radius = Math.max(1, Math.floor(height * 0.03));

  for (let dy = -radius; dy <= radius; dy++) {
    const y = targetY + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = (targetX + dx + width) % width;
      if (dx * dx + dy * dy <= radius * radius) {
        const offset = (y * width + x) * 3;
        img.data[offset] = emitterRadiance;
        img.data[offset + 1] = emitterRadiance * 0.9;
        img.data[offset + 2] = emitterRadiance * 0.8;
      }
    }
  }
  return img;
}

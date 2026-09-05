import type { PixelReadbackInspection } from './types';

/**
 * Validates RGBA8 pixels from the rendered canvas.
 *
 * The minimal oracle deliberately avoids a platform-sensitive golden comparison: a valid
 * probe must contain at least two opaque colors, proving that it did more than clear a target.
 *
 * @throws When `pixels` does not contain complete RGBA8 texels.
 */
export function inspectPixelReadback(pixels: Uint8Array): PixelReadbackInspection {
  if (pixels.byteLength % 4 !== 0) {
    throw new Error('Doctor pixel readback must contain complete RGBA8 texels.');
  }

  const colors = new Set<number>();
  let opaquePixels = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const red = pixels[offset]!;
    const green = pixels[offset + 1]!;
    const blue = pixels[offset + 2]!;
    const alpha = pixels[offset + 3]!;
    if (alpha === 255) opaquePixels += 1;
    colors.add(((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0);
  }

  return Object.freeze({
    byteLength: pixels.byteLength,
    checksum: `fnv1a32:${fnv1a32(pixels)}`,
    opaquePixels,
    distinctColors: colors.size,
    verified: pixels.byteLength > 0 && opaquePixels > 0 && colors.size > 1
  });
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

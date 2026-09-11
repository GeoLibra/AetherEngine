/**
 * @file Exact longitude/cosine-latitude spherical-area filtering for environment panorama mipmaps.
 * Generates ordinary minification mips preserving constant radiance through the 1x1 terminal pixel.
 */

import { packRgbToRgba16Float } from '../artifact/binary-packing';
import { computeSha256Digest } from '../artifact/recipe-key';
import type {
  EnvironmentMip,
  EnvironmentTexturePayload
} from '../../../../src/assets/environment/artifact/types';
import type { CanonicalHdrPanorama } from '../decode/types';

/**
 * Computes halving mip dimensions down to 1x1.
 * When dimensions are not equal (e.g. 2:1 base), saturation at 1 occurs (e.g. 2x1 -> 1x1).
 */
export function computeMipDimensions(
  baseWidth: number,
  baseHeight: number
): readonly [number, number][] {
  if (baseWidth < 1 || baseHeight < 1) {
    throw new Error('Base mip dimensions must be positive.');
  }
  const result: [number, number][] = [];
  let w = Math.floor(baseWidth);
  let h = Math.floor(baseHeight);
  while (true) {
    result.push([w, h]);
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return Object.freeze(result);
}

/**
 * Filters a source equirectangular panorama into a destination mip level using exact spherical area averaging.
 *
 * @param srcData Interleaved RGB float32 buffer (length: srcWidth * srcHeight * 3)
 * @param srcWidth Source panorama width
 * @param srcHeight Source panorama height
 * @param dstWidth Destination mip width
 * @param dstHeight Destination mip height
 */
export function filterSphericalAreaMip(
  srcData: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Float32Array {
  if (dstWidth > srcWidth || dstHeight > srcHeight) {
    throw new Error(
      `filterSphericalAreaMip does not support upscaling (src: ${srcWidth}x${srcHeight}, dst: ${dstWidth}x${dstHeight}).`
    );
  }

  const dstData = new Float32Array(dstWidth * dstHeight * 3);

  for (let dy = 0; dy < dstHeight; dy++) {
    const v0 = dy / dstHeight;
    const v1 = (dy + 1) / dstHeight;

    const sy0 = Math.floor(v0 * srcHeight);
    const sy1 = Math.min(srcHeight - 1, Math.floor(v1 * srcHeight - 1e-9));

    for (let dx = 0; dx < dstWidth; dx++) {
      const u0 = dx / dstWidth;
      const u1 = (dx + 1) / dstWidth;

      const sx0 = Math.floor(u0 * srcWidth);
      const sx1 = Math.min(srcWidth - 1, Math.floor(u1 * srcWidth - 1e-9));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let totalWeight = 0;

      for (let sy = sy0; sy <= sy1; sy++) {
        const rowV0 = Math.max(v0, sy / srcHeight);
        const rowV1 = Math.min(v1, (sy + 1) / srcHeight);
        const rowW = Math.cos(Math.PI * rowV0) - Math.cos(Math.PI * rowV1);
        if (rowW <= 0) continue;

        const rowOffset = sy * srcWidth * 3;

        for (let sx = sx0; sx <= sx1; sx++) {
          const colU0 = Math.max(u0, sx / srcWidth);
          const colU1 = Math.min(u1, (sx + 1) / srcWidth);
          const colW = colU1 - colU0;
          if (colW <= 0) continue;

          const w = rowW * colW;
          const srcIdx = rowOffset + sx * 3;

          sumR += srcData[srcIdx]! * w;
          sumG += srcData[srcIdx + 1]! * w;
          sumB += srcData[srcIdx + 2]! * w;
          totalWeight += w;
        }
      }

      const invW = totalWeight > 0 ? 1 / totalWeight : 0;
      const dstIdx = (dy * dstWidth + dx) * 3;
      dstData[dstIdx] = sumR * invW;
      dstData[dstIdx + 1] = sumG * invW;
      dstData[dstIdx + 2] = sumB * invW;
    }
  }

  return dstData;
}

/**
 * Cooks a complete panorama mip chain into an RGBA16F binary blob and EnvironmentTexturePayload.
 */
export function cookPanoramaMipChain(
  canonicalHdr: CanonicalHdrPanorama,
  maxBaseSize?: readonly [number, number]
): { payload: EnvironmentTexturePayload; blob: Uint8Array } {
  let baseW = canonicalHdr.width;
  let baseH = canonicalHdr.height;

  if (maxBaseSize !== undefined) {
    while (baseW > maxBaseSize[0] || baseH > maxBaseSize[1]) {
      if (baseW <= 2 || baseH <= 1) break;
      baseW = Math.floor(baseW / 2);
      baseH = Math.floor(baseH / 2);
    }
  }

  const mipDims = computeMipDimensions(baseW, baseH);
  const mipBlobs: Uint8Array[] = [];
  const mipRecords: EnvironmentMip[] = [];

  let totalBytes = 0;
  for (let level = 0; level < mipDims.length; level++) {
    const [w, h] = mipDims[level]!;
    const levelRgb =
      w === canonicalHdr.width && h === canonicalHdr.height
        ? canonicalHdr.pixels
        : filterSphericalAreaMip(
            canonicalHdr.pixels,
            canonicalHdr.width,
            canonicalHdr.height,
            w,
            h
          );

    const levelBlob = packRgbToRgba16Float(levelRgb, w, h);
    const levelHash = computeSha256Digest(levelBlob);

    mipRecords.push({
      level,
      width: w,
      height: h,
      byteOffset: totalBytes,
      byteLength: levelBlob.byteLength,
      contentHash: levelHash
    });

    mipBlobs.push(levelBlob);
    totalBytes += levelBlob.byteLength;
  }

  const fullBlob = new Uint8Array(totalBytes);
  for (let i = 0; i < mipBlobs.length; i++) {
    const record = mipRecords[i]!;
    fullBlob.set(mipBlobs[i]!, record.byteOffset);
  }

  const blobHash = computeSha256Digest(fullBlob);

  return {
    payload: Object.freeze({
      format: 'rgba16float' as const,
      blobHash,
      byteLength: totalBytes,
      levels: Object.freeze(mipRecords)
    }),
    blob: fullBlob
  };
}

import { describe, expect, it } from 'vitest';
import {
  computeMipDimensions,
  filterSphericalAreaMip,
  cookPanoramaMipChain
} from '../../tools/asset-cook/environment/filtering/panorama-filter';
import type { CanonicalHdrPanorama } from '../../tools/asset-cook/environment/decode/types';

describe('panorama spherical-area mip filtering', () => {
  it('computes halving mip dimensions terminating at 1x1', () => {
    const dims = computeMipDimensions(64, 32);
    expect(dims).toEqual([
      [64, 32],
      [32, 16],
      [16, 8],
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1]
    ]);
  });

  it('preserves constant radiance across all mips down to 1x1', () => {
    const srcW = 32;
    const srcH = 16;
    const c0 = 2.5;
    const c1 = 1.25;
    const c2 = 0.75;
    const srcData = new Float32Array(srcW * srcH * 3);
    for (let i = 0; i < srcW * srcH; i++) {
      srcData[i * 3] = c0;
      srcData[i * 3 + 1] = c1;
      srcData[i * 3 + 2] = c2;
    }

    const dims = computeMipDimensions(16, 8);
    for (const [w, h] of dims) {
      const mip = filterSphericalAreaMip(srcData, srcW, srcH, w, h);
      expect(mip.length).toBe(w * h * 3);
      for (let p = 0; p < w * h; p++) {
        expect(Math.abs((mip[p * 3] ?? 0) - c0)).toBeLessThan(1e-5);
        expect(Math.abs((mip[p * 3 + 1] ?? 0) - c1)).toBeLessThan(1e-5);
        expect(Math.abs((mip[p * 3 + 2] ?? 0) - c2)).toBeLessThan(1e-5);
      }
    }
  });

  it('cooks a complete panorama mip chain into an RGBA16F binary blob', () => {
    const srcW = 16;
    const srcH = 8;
    const srcData = new Float32Array(srcW * srcH * 3);
    srcData.fill(1.0);

    const hdr: CanonicalHdrPanorama = {
      width: srcW,
      height: srcH,
      pixels: srcData,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 0 }
    };

    const result = cookPanoramaMipChain(hdr, [16, 8]);
    expect(result.payload.format).toBe('rgba16float');
    expect(result.payload.levels.length).toBe(5); // 16x8, 8x4, 4x2, 2x1, 1x1
    expect(result.blob.byteLength).toBe(result.payload.byteLength);

    const level0 = result.payload.levels[0]!;
    expect(level0.width).toBe(16);
    expect(level0.height).toBe(8);

    const terminalLevel = result.payload.levels.at(-1)!;
    expect(terminalLevel.width).toBe(1);
    expect(terminalLevel.height).toBe(1);
  });

  it('rejects upscaling in filterSphericalAreaMip', () => {
    const srcData = new Float32Array(16 * 8 * 3);
    expect(() => filterSphericalAreaMip(srcData, 16, 8, 32, 16)).toThrow(
      /does not support upscaling/
    );
  });
});

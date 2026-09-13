import { describe, expect, test, vi } from 'vitest';
import { decodeBrowserImageTexture } from '../../src/assets/importers/loaders-gl/browser-image-decoder';
import type { CanonicalTextureDocument } from '../../src/assets/canonical/types';

describe('decodeBrowserImageTexture', () => {
  test('returns document unchanged if data is empty or dimensions already valid', async () => {
    const emptyDoc: CanonicalTextureDocument = {
      id: 'tex.empty' as any,
      kind: 'texture',
      version: 1
    };
    const res1 = await decodeBrowserImageTexture(emptyDoc);
    expect(res1).toBe(emptyDoc);

    const alreadyDecoded: CanonicalTextureDocument = {
      id: 'tex.raw' as any,
      kind: 'texture',
      version: 1,
      width: 2,
      height: 2,
      data: new Uint8Array(16)
    };
    const res2 = await decodeBrowserImageTexture(alreadyDecoded);
    expect(res2).toBe(alreadyDecoded);
  });

  test('gracefully returns unchanged document if browser image APIs are unavailable', async () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    // @ts-expect-error simulate non-browser environment
    delete globalThis.createImageBitmap;

    try {
      const compressedDoc: CanonicalTextureDocument = {
        id: 'tex.jpg' as any,
        kind: 'texture',
        version: 1,
        mimeType: 'image/jpeg',
        data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      };
      const res = await decodeBrowserImageTexture(compressedDoc);
      expect(res).toBe(compressedDoc);
    } finally {
      if (originalCreateImageBitmap) {
        globalThis.createImageBitmap = originalCreateImageBitmap;
      }
    }
  });
});

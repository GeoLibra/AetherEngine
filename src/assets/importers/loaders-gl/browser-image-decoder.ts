import type { CanonicalTextureDocument } from '../../canonical/types';

/**
 * Decodes compressed image bytes (JPEG, PNG, WebP) in a CanonicalTextureDocument
 * into uncompressed 32-bit RGBA pixel data with explicit width and height.
 * In a non-browser environment or if createImageBitmap is not available,
 * returns the texture document unchanged.
 */
export async function decodeBrowserImageTexture(
  texture: CanonicalTextureDocument
): Promise<CanonicalTextureDocument> {
  if (!texture.data || texture.data.byteLength === 0) {
    return texture;
  }
  // Already decoded if dimensions exist and match 4 bytes per pixel
  if (
    typeof texture.width === 'number' &&
    typeof texture.height === 'number' &&
    texture.data.byteLength === texture.width * texture.height * 4
  ) {
    return texture;
  }

  if (typeof createImageBitmap === 'undefined' || typeof Blob === 'undefined') {
    return texture;
  }

  const mimeType = texture.mimeType ?? 'image/jpeg';
  const blob = new Blob([texture.data as unknown as BlobPart], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  let imgData: ImageData;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return texture;
    }
    ctx.drawImage(bitmap, 0, 0);
    imgData = ctx.getImageData(0, 0, width, height);
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return texture;
    }
    ctx.drawImage(bitmap, 0, 0);
    imgData = ctx.getImageData(0, 0, width, height);
  } else {
    bitmap.close();
    return texture;
  }
  bitmap.close();

  return {
    ...texture,
    width,
    height,
    data: new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
  };
}

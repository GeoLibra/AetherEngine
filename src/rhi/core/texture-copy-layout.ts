import type {
  GPUImageCopyBuffer,
  GPUImageCopyTexture,
  RHIBuffer,
  RHINormalizedExtent3D,
  RHINormalizedImageCopyBuffer,
  RHITexture
} from '../contracts';
import { toResourceRef } from './resource-ref';
import { textureMipDimension } from './texture-dimensions';

const BUFFER_COPY_SRC = 1 << 2;
const BUFFER_COPY_DST = 1 << 3;
const TEXTURE_COPY_SRC = 1 << 0;
const TEXTURE_COPY_DST = 1 << 1;
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

interface TexelBlockLayout { readonly width: number; readonly height: number; readonly bytes: number }

const FORMAT_BLOCKS: Readonly<Record<string, TexelBlockLayout>> = Object.freeze({
  r8unorm: { width: 1, height: 1, bytes: 1 }, r8snorm: { width: 1, height: 1, bytes: 1 },
  r8uint: { width: 1, height: 1, bytes: 1 }, r8sint: { width: 1, height: 1, bytes: 1 },
  rg8unorm: { width: 1, height: 1, bytes: 2 }, rg8snorm: { width: 1, height: 1, bytes: 2 },
  rgba8unorm: { width: 1, height: 1, bytes: 4 }, 'rgba8unorm-srgb': { width: 1, height: 1, bytes: 4 },
  bgra8unorm: { width: 1, height: 1, bytes: 4 }, 'bgra8unorm-srgb': { width: 1, height: 1, bytes: 4 },
  rgba16float: { width: 1, height: 1, bytes: 8 }, rgba32float: { width: 1, height: 1, bytes: 16 },
  'bc1-rgba-unorm': { width: 4, height: 4, bytes: 8 }, 'bc1-rgba-unorm-srgb': { width: 4, height: 4, bytes: 8 },
  'bc3-rgba-unorm': { width: 4, height: 4, bytes: 16 }, 'bc3-rgba-unorm-srgb': { width: 4, height: 4, bytes: 16 }
});

export function validateBufferTextureCopy(
  copy: GPUImageCopyBuffer,
  textureCopy: GPUImageCopyTexture,
  size: RHINormalizedExtent3D,
  direction: 'buffer-to-texture' | 'texture-to-buffer'
): RHINormalizedImageCopyBuffer {
  const texture = textureCopy.texture;
  const bufferUsage = direction === 'buffer-to-texture' ? BUFFER_COPY_SRC : BUFFER_COPY_DST;
  const textureUsage = direction === 'buffer-to-texture' ? TEXTURE_COPY_DST : TEXTURE_COPY_SRC;
  const bufferUsageName = direction === 'buffer-to-texture' ? 'COPY_SRC' : 'COPY_DST';
  const textureUsageName = direction === 'buffer-to-texture' ? 'COPY_DST' : 'COPY_SRC';
  requireUsage(copy.buffer, bufferUsage, bufferUsageName);
  if ((texture.usage & textureUsage) === 0) {
    throw new Error(`Texture "${texture.label ?? texture.id}" requires ${textureUsageName} usage.`);
  }
  const block = FORMAT_BLOCKS[texture.format];
  if (block === undefined) throw new Error(`Texture format "${texture.format}" has no portable copy block layout.`);
  const offset = copy.offset ?? 0;
  if (offset % 4 !== 0) throw new Error(`Buffer copy offset ${offset} must be a multiple of 4.`);
  validateBlockBounds(textureCopy, size, block);
  const blockColumns = Math.ceil(size.width / block.width);
  const blockRows = Math.ceil(size.height / block.height);
  const bytesInLastRow = blockColumns * block.bytes;
  const bytesPerRow = copy.bytesPerRow ?? bytesInLastRow;
  const rowsPerImage = copy.rowsPerImage ?? blockRows;
  for (const [label, value] of [['offset', offset], ['bytesPerRow', bytesPerRow], ['rowsPerImage', rowsPerImage]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} ${value} must be a non-negative integer.`);
  }
  if (bytesPerRow % COPY_BYTES_PER_ROW_ALIGNMENT !== 0) {
    throw new Error(`bytesPerRow ${bytesPerRow} must be a multiple of ${COPY_BYTES_PER_ROW_ALIGNMENT}.`);
  }
  if (bytesPerRow < bytesInLastRow) throw new Error(`bytesPerRow ${bytesPerRow} is smaller than required row size ${bytesInLastRow}.`);
  if (rowsPerImage < blockRows) throw new Error(`rowsPerImage ${rowsPerImage} is smaller than required image rows ${blockRows}.`);
  const requiredEnd = offset +
    Math.max(size.depthOrArrayLayers - 1, 0) * rowsPerImage * bytesPerRow +
    Math.max(blockRows - 1, 0) * bytesPerRow + bytesInLastRow;
  if (requiredEnd > copy.buffer.size) {
    throw new Error(`Buffer-texture copy requires buffer range ${offset}..${requiredEnd} outside buffer size ${copy.buffer.size}.`);
  }
  return Object.freeze({ buffer: toResourceRef(copy.buffer), offset, bytesPerRow, rowsPerImage });
}

function validateBlockBounds(
  copy: GPUImageCopyTexture,
  size: RHINormalizedExtent3D,
  block: TexelBlockLayout
): void {
  if (block.width === 1 && block.height === 1) return;
  const tuple = Array.isArray(copy.origin) ? copy.origin as readonly number[] : undefined;
  const object = tuple === undefined
    ? copy.origin as { x?: number; y?: number } | undefined
    : undefined;
  const origin = tuple === undefined
    ? { x: object?.x ?? 0, y: object?.y ?? 0 }
    : { x: tuple[0] ?? 0, y: tuple[1] ?? 0 };
  const mipLevel = copy.mipLevel ?? 0;
  const mipWidth = textureMipDimension(copy.texture.width, mipLevel);
  const mipHeight = textureMipDimension(copy.texture.height, mipLevel);
  if (origin.x % block.width !== 0 || origin.y % block.height !== 0) {
    throw new Error(`Texture copy origin must align to ${block.width}x${block.height} format blocks.`);
  }
  if (size.width % block.width !== 0 && origin.x + size.width !== mipWidth) {
    throw new Error(`Texture copy width must align to ${block.width}-texel format blocks or reach the mip edge.`);
  }
  if (size.height % block.height !== 0 && origin.y + size.height !== mipHeight) {
    throw new Error(`Texture copy height must align to ${block.height}-texel format blocks or reach the mip edge.`);
  }
}

function requireUsage(buffer: RHIBuffer, usage: number, name: string): void {
  if ((buffer.usage & usage) === 0) throw new Error(`Buffer "${buffer.label ?? buffer.id}" requires ${name} usage.`);
}

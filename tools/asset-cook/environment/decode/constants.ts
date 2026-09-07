/**
 * @file Bounded constants and admission limits for Radiance RGBE import.
 */

export const HDR_LIMITS = Object.freeze({
  MAX_HEADER_BYTES: 64 * 1024, // 64 KiB
  MAX_LINE_BYTES: 4 * 1024, // 4 KiB
  MAX_SOURCE_BYTES: 128 * 1024 * 1024, // 128 MiB
  MAX_DIMENSION: 8192,
  MAX_PIXELS: 16_777_216,
  MIN_RLE_SCANLINE_LENGTH: 8,
  MAX_RLE_SCANLINE_LENGTH: 32767,
  MAX_FLOAT16_FINITE: 65504.0
} as const);

export const HDR_MAGIC_SIGNATURES = Object.freeze(['#?RADIANCE', '#?RGBE'] as const);

export const HDR_REQUIRED_FORMAT = 'FORMAT=32-bit_rle_rgbe';

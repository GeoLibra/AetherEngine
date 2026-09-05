import type { CpuLightListCapacity, WebGlLightListPacking } from '../types';

/**
 * Calculates the fixed integer-texture layout used by the WebGL2 fragment fallback.
 * Row zero stores headers and global values; following rows store four light indices per texel.
 *
 * @throws When the receiver count or capacity is not a non-negative safe integer.
 */
export function calculateWebGlLightListPacking(
  receiverCount: number,
  capacity: CpuLightListCapacity,
  maxTextureDimension2D: number
): WebGlLightListPacking {
  assertNonNegativeInteger('receiver count', receiverCount);
  assertNonNegativeInteger('maximum directional lights', capacity.maxDirectionalLights);
  assertNonNegativeInteger('maximum lights per receiver', capacity.maxLightsPerReceiver);
  assertNonNegativeInteger('maximum light indices', capacity.maxLightIndices);
  if (!Number.isSafeInteger(maxTextureDimension2D) || maxTextureDimension2D < 1) {
    throw new Error('WebGL2 light-list maximum texture dimension must be a positive integer.');
  }

  const indexRows = Math.ceil(capacity.maxLightsPerReceiver / 4);
  const minimumWidth = Math.max(1, Math.ceil(capacity.maxDirectionalLights / 4));
  if (minimumWidth > maxTextureDimension2D || 1 + indexRows > maxTextureDimension2D) {
    throw new Error('WebGL2 light-list capacity exceeds the configured texture dimension.');
  }
  const width = Math.max(minimumWidth, Math.min(Math.max(1, receiverCount), maxTextureDimension2D));
  const receiverRows = Math.max(1, Math.ceil(receiverCount / width));
  const height = receiverRows * (1 + indexRows);
  if (height > maxTextureDimension2D) {
    throw new Error('WebGL2 light-list receiver count exceeds the configured texture capacity.');
  }
  return Object.freeze({ width, height, indexRows, receiverRows });
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WebGL2 light-list ${label} must be a non-negative integer.`);
  }
}

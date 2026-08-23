import type { BrowserWebGL2TextureFacts } from './resource-port';

export interface BrowserWebGL2TextureSubresource {
  readonly texture: object;
  readonly mipLevel: number;
  readonly width: number;
  readonly height: number;
  readonly facts: BrowserWebGL2TextureFacts;
}

export function textureSubresource(
  value: object,
  textureFacts: WeakMap<object, BrowserWebGL2TextureFacts>,
  fields: Readonly<{
    texture: string;
    mipLevel: string;
    width: string;
    height: string;
  }>
): BrowserWebGL2TextureSubresource {
  const texture = Reflect.get(value, fields.texture);
  if (typeof texture !== 'object' || texture === null)
    throw new TypeError(`Framebuffer ${fields.texture} is invalid.`);
  const facts = textureFacts.get(texture);
  if (facts === undefined)
    throw new Error('Framebuffer attachment is not owned by this browser WebGL2 context.');
  const mipLevel = optionalInteger(value, fields.mipLevel, 0);
  if (mipLevel < 0 || mipLevel >= facts.mipLevelCount) {
    throw new Error(`WebGL2 texture mip level ${mipLevel} is outside [0, ${facts.mipLevelCount}).`);
  }
  const width = mipDimension(facts.width, mipLevel);
  const height = mipDimension(facts.height, mipLevel);
  validateOptionalDimension(value, fields.width, width);
  validateOptionalDimension(value, fields.height, height);
  return { texture, mipLevel, width, height, facts };
}

function optionalInteger(value: object, field: string, fallback: number): number {
  const result = Reflect.get(value, field);
  if (result === undefined) return fallback;
  if (!Number.isInteger(result)) throw new TypeError(`WebGL2 ${field} must be an integer.`);
  return result as number;
}

function validateOptionalDimension(value: object, field: string, expected: number): void {
  const result = Reflect.get(value, field);
  if (result !== undefined && result !== expected) {
    throw new Error(`WebGL2 ${field} must be ${expected}, received ${String(result)}.`);
  }
}

function mipDimension(base: number, mipLevel: number): number {
  return Math.max(1, Math.floor(base / 2 ** mipLevel));
}

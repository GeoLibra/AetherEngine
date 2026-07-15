/** Returns one texture dimension at a mip level without allowing it to reach zero. */
export function textureMipDimension(baseDimension: number, mipLevel: number): number {
  return Math.max(1, Math.floor(baseDimension / 2 ** mipLevel));
}

export function validateTextureViewMipLevel(
  baseMipLevel: number | undefined,
  mipLevelCount: number | undefined
): number {
  const level = baseMipLevel ?? 0;
  const count = mipLevelCount ?? 1;
  if (!Number.isInteger(level) || level < 0 || level >= count) {
    throw new Error(`Texture view baseMipLevel ${level} is outside mipLevelCount ${count}.`);
  }
  return level;
}

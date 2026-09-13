import type { AssetId } from '../types';
import type { CanonicalSamplerDocument, CanonicalTextureDocument } from '../canonical/types';
import type {
  CookedSamplerArtifact,
  CookedTextureArtifact,
  CookedTextureFormat,
  CookedTextureRole,
  CookedTextureSemantic
} from './types';

export const BUILTIN_TEXTURE_IDS = Object.freeze({
  WhiteSrgb: 'aether.texture.white-srgb',
  WhiteData: 'aether.texture.white-data',
  FlatNormal: 'aether.texture.flat-normal',
  BlackSrgb: 'aether.texture.black-srgb'
} as const);

export const BUILTIN_SAMPLER_IDS = Object.freeze({
  LinearRepeat: 'aether.sampler.linear-repeat'
} as const);

/**
 * Maps a texture role to its required material shader semantic and color space format.
 */
export function getRoleProperties(role: CookedTextureRole): {
  semantic: CookedTextureSemantic;
  format: CookedTextureFormat;
} {
  switch (role) {
    case 'base-color':
      return { semantic: 'color', format: 'rgba8unorm-srgb' };
    case 'metallic-roughness':
      return { semantic: 'data', format: 'rgba8unorm' };
    case 'normal':
      return { semantic: 'normal', format: 'rgba8unorm' };
    case 'occlusion':
      return { semantic: 'data', format: 'rgba8unorm' };
    case 'emissive':
      return { semantic: 'color', format: 'rgba8unorm-srgb' };
  }
}

export type TextureReadiness = 'ready' | 'not-ready' | 'absent' | 'invalid';

/**
 * Assesses the readiness of a CanonicalTextureDocument for GPU cooking.
 * A texture is ready only when decoded into uncompressed raw RGBA8 pixels matching width x height.
 */
export function getTextureReadiness(texture: CanonicalTextureDocument): TextureReadiness {
  if (!texture.data && !texture.uri) {
    return 'absent';
  }
  if (texture.uri && !texture.data) {
    return 'not-ready';
  }
  if (texture.data) {
    if (
      typeof texture.width !== 'number' ||
      typeof texture.height !== 'number' ||
      texture.width <= 0 ||
      texture.height <= 0
    ) {
      return 'not-ready';
    }
    const expectedByteLength = texture.width * texture.height * 4;
    if (texture.data.byteLength !== expectedByteLength) {
      if (texture.mimeType && texture.mimeType.startsWith('image/')) {
        return 'not-ready';
      }
      return 'invalid';
    }
    return 'ready';
  }
  return 'absent';
}

/**
 * Constructs the canonical cooked asset ID for a texture according to its PBR usage role.
 * Role-scoping prevents collision when a single source texture is bound to both color and data slots.
 */
export function getCookedTextureId(textureId: string, role: CookedTextureRole): AssetId {
  if (textureId.startsWith('aether.texture.')) {
    return textureId as AssetId;
  }
  if (textureId.endsWith(`:${role}`)) {
    return textureId as AssetId;
  }
  return `${textureId}:${role}` as AssetId;
}

/**
 * Cooks a CanonicalTextureDocument according to its intended PBR role.
 *
 * @throws {Error} If the texture is absent, not-ready, compressed, or has size mismatch.
 */
export function cookCanonicalTexture(
  texture: CanonicalTextureDocument,
  role: CookedTextureRole
): CookedTextureArtifact {
  const readiness = getTextureReadiness(texture);
  if (readiness !== 'ready') {
    const reason =
      readiness === 'absent'
        ? 'texture has neither pixel data nor URI'
        : readiness === 'not-ready'
          ? `texture is not ready or has not been decoded to uncompressed RGBA8 pixels (dimensions: ${texture.width ?? 'undefined'}x${texture.height ?? 'undefined'}, byteLength: ${texture.data?.byteLength ?? 0}, mime: ${texture.mimeType ?? 'unknown'})`
          : `pixel byteLength ${texture.data?.byteLength} does not match expected size (${texture.width}x${texture.height}x4 = ${(texture.width ?? 0) * (texture.height ?? 0) * 4})`;
    throw new Error(
      `Cannot cook texture "${texture.id}" for role "${role}": ${reason}. Textures must be fully decoded to uncompressed RGBA8 before cooking.`
    );
  }

  const { semantic, format } = getRoleProperties(role);
  const width = texture.width!;
  const height = texture.height!;
  let data = texture.data!;

  if (role === 'normal') {
    data = normalizeNormalMapData(data, width * height);
  }

  return {
    id: getCookedTextureId(texture.id, role),
    kind: 'texture',
    version: texture.version,
    role,
    semantic,
    format,
    width,
    height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    mipCount: 1
  };
}

/**
 * Cooks a CanonicalSamplerDocument into an immutable CookedSamplerArtifact.
 */
export function cookCanonicalSampler(sampler: CanonicalSamplerDocument): CookedSamplerArtifact {
  const { minFilter, mipmapFilter } = splitMinFilter(sampler.minFilter);
  return {
    id: sampler.id,
    kind: 'sampler',
    version: sampler.version,
    magFilter: sampler.magFilter ?? 'linear',
    minFilter,
    mipmapFilter,
    addressModeU: sampler.wrapS ?? 'repeat',
    addressModeV: sampler.wrapT ?? 'repeat'
  };
}

function splitMinFilter(filter?: CanonicalSamplerDocument['minFilter']): {
  minFilter: 'linear' | 'nearest';
  mipmapFilter: 'linear' | 'nearest';
} {
  switch (filter) {
    case 'nearest':
    case 'nearest-mipmap-nearest':
      return { minFilter: 'nearest', mipmapFilter: 'nearest' };
    case 'nearest-mipmap-linear':
      return { minFilter: 'nearest', mipmapFilter: 'linear' };
    case 'linear-mipmap-nearest':
      return { minFilter: 'linear', mipmapFilter: 'nearest' };
    case 'linear':
    case 'linear-mipmap-linear':
    default:
      return { minFilter: 'linear', mipmapFilter: 'linear' };
  }
}

export function createDefaultWhiteSrgbTexture(): CookedTextureArtifact {
  return {
    id: BUILTIN_TEXTURE_IDS.WhiteSrgb as AssetId,
    kind: 'texture',
    version: 1,
    role: 'base-color',
    semantic: 'color',
    format: 'rgba8unorm-srgb',
    width: 1,
    height: 1,
    data: new Uint8Array([255, 255, 255, 255]),
    mipCount: 1
  };
}

export function createDefaultWhiteDataTexture(): CookedTextureArtifact {
  return {
    id: BUILTIN_TEXTURE_IDS.WhiteData as AssetId,
    kind: 'texture',
    version: 1,
    role: 'metallic-roughness',
    semantic: 'data',
    format: 'rgba8unorm',
    width: 1,
    height: 1,
    data: new Uint8Array([255, 255, 255, 255]),
    mipCount: 1
  };
}

export function createDefaultFlatNormalTexture(): CookedTextureArtifact {
  return {
    id: BUILTIN_TEXTURE_IDS.FlatNormal as AssetId,
    kind: 'texture',
    version: 1,
    role: 'normal',
    semantic: 'normal',
    format: 'rgba8unorm',
    width: 1,
    height: 1,
    data: new Uint8Array([128, 128, 255, 255]),
    mipCount: 1
  };
}

export function createDefaultBlackSrgbTexture(): CookedTextureArtifact {
  return {
    id: BUILTIN_TEXTURE_IDS.BlackSrgb as AssetId,
    kind: 'texture',
    version: 1,
    role: 'emissive',
    semantic: 'color',
    format: 'rgba8unorm-srgb',
    width: 1,
    height: 1,
    data: new Uint8Array([0, 0, 0, 255]),
    mipCount: 1
  };
}

export function createDefaultLinearRepeatSampler(): CookedSamplerArtifact {
  return {
    id: BUILTIN_SAMPLER_IDS.LinearRepeat as AssetId,
    kind: 'sampler',
    version: 1,
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat'
  };
}

function createFallbackPixelData(role: CookedTextureRole): Uint8Array {
  switch (role) {
    case 'base-color':
    case 'metallic-roughness':
    case 'occlusion':
      return new Uint8Array([255, 255, 255, 255]);
    case 'normal':
      return new Uint8Array([128, 128, 255, 255]);
    case 'emissive':
      return new Uint8Array([0, 0, 0, 255]);
  }
}

function normalizeNormalMapData(data: Uint8Array, pixelCount: number): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    let r = (data[offset]! / 255.0) * 2.0 - 1.0;
    let g = (data[offset + 1]! / 255.0) * 2.0 - 1.0;
    let b = (data[offset + 2]! / 255.0) * 2.0 - 1.0;

    const len = Math.hypot(r, g, b);
    if (len > 1e-6) {
      r /= len;
      g /= len;
      b /= len;
    } else {
      r = 0;
      g = 0;
      b = 1;
    }

    result[offset] = Math.round((r + 1.0) * 0.5 * 255.0);
    result[offset + 1] = Math.round((g + 1.0) * 0.5 * 255.0);
    result[offset + 2] = Math.round((b + 1.0) * 0.5 * 255.0);
    result[offset + 3] = data[offset + 3]!;
  }
  return result;
}

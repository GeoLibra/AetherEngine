import type {
  CanonicalNormalTextureSlot,
  CanonicalOcclusionTextureSlot,
  CanonicalStandardPbrMaterial,
  CanonicalTextureSlot,
  TextureUvTransform
} from '../../canonical/types';
import type { AssetId } from '../../types';

export interface GltfMaterialContext {
  readonly assetPrefix: string;
  readonly defaultSamplerId: AssetId;
  readonly getTextureSlot: (
    textureInfo: Record<string, any> | undefined,
    role: 'color' | 'data' | 'normal',
    slotPath?: string
  ) => CanonicalTextureSlot | null;
}

/**
 * Maps a glTF 2.0 PBR metallic-roughness material to CanonicalStandardPbrMaterial.
 */
export function unpackGltfMaterial(
  materialIndex: number,
  gltfMaterial: Record<string, any>,
  context: GltfMaterialContext
): CanonicalStandardPbrMaterial {
  const pbr = gltfMaterial.pbrMetallicRoughness ?? {};

  const baseColorFactor = (pbr.baseColorFactor ?? [1, 1, 1, 1]) as readonly [
    number,
    number,
    number,
    number
  ];

  const metallicFactor = typeof pbr.metallicFactor === 'number' ? pbr.metallicFactor : 1.0;
  const roughnessFactor = typeof pbr.roughnessFactor === 'number' ? pbr.roughnessFactor : 1.0;

  const emissiveFactor = (gltfMaterial.emissiveFactor ?? [0, 0, 0]) as readonly [
    number,
    number,
    number
  ];

  const baseColorTexture = context.getTextureSlot(
    pbr.baseColorTexture,
    'color',
    `materials[${materialIndex}].pbrMetallicRoughness.baseColorTexture`
  );
  const metallicRoughnessTexture = context.getTextureSlot(
    pbr.metallicRoughnessTexture,
    'data',
    `materials[${materialIndex}].pbrMetallicRoughness.metallicRoughnessTexture`
  );

  const rawNormal = gltfMaterial.normalTexture;
  let normalTexture: CanonicalNormalTextureSlot | null = null;
  if (rawNormal) {
    const slot = context.getTextureSlot(
      rawNormal,
      'normal',
      `materials[${materialIndex}].normalTexture`
    );
    if (slot) {
      normalTexture = Object.freeze({
        ...slot,
        scale: typeof rawNormal.scale === 'number' ? rawNormal.scale : 1.0
      });
    }
  }

  const rawOcclusion = gltfMaterial.occlusionTexture;
  let occlusionTexture: CanonicalOcclusionTextureSlot | null = null;
  if (rawOcclusion) {
    const slot = context.getTextureSlot(
      rawOcclusion,
      'data',
      `materials[${materialIndex}].occlusionTexture`
    );
    if (slot) {
      occlusionTexture = Object.freeze({
        ...slot,
        strength: typeof rawOcclusion.strength === 'number' ? rawOcclusion.strength : 1.0
      });
    }
  }

  const emissiveTexture = context.getTextureSlot(
    gltfMaterial.emissiveTexture,
    'color',
    `materials[${materialIndex}].emissiveTexture`
  );

  let alphaMode: 'opaque' | 'mask' | 'blend' = 'opaque';
  if (gltfMaterial.alphaMode !== undefined) {
    const rawMode = gltfMaterial.alphaMode;
    if (rawMode === 'OPAQUE') {
      alphaMode = 'opaque';
    } else if (rawMode === 'MASK') {
      alphaMode = 'mask';
    } else if (rawMode === 'BLEND') {
      alphaMode = 'blend';
    } else {
      throw new Error(
        `Invalid alphaMode "${rawMode}" in material ${materialIndex}: must be one of "OPAQUE", "MASK", or "BLEND".`
      );
    }
  }

  const alphaCutoff = typeof gltfMaterial.alphaCutoff === 'number' ? gltfMaterial.alphaCutoff : 0.5;
  const doubleSided = Boolean(gltfMaterial.doubleSided);

  const id = `${context.assetPrefix}:material:${materialIndex}` as AssetId;

  return Object.freeze({
    id,
    kind: 'material',
    version: 1,
    ...(gltfMaterial.name ? { name: gltfMaterial.name } : {}),
    baseColorFactor,
    baseColorTexture,
    metallicFactor,
    roughnessFactor,
    metallicRoughnessTexture,
    normalTexture,
    occlusionTexture,
    emissiveFactor,
    emissiveTexture,
    alphaMode,
    alphaCutoff,
    doubleSided
  });
}

/**
 * Parses KHR_texture_transform extension from a glTF texture info object.
 */
export function unpackTextureUvTransform(textureInfo: Record<string, any>): TextureUvTransform {
  const ext = textureInfo.extensions?.KHR_texture_transform;
  if (!ext) {
    return Object.freeze({
      offset: Object.freeze([0, 0]) as readonly [number, number],
      scale: Object.freeze([1, 1]) as readonly [number, number],
      rotation: 0
    });
  }

  const offset = (ext.offset ?? [0, 0]) as [number, number];
  const scale = (ext.scale ?? [1, 1]) as [number, number];
  const rotation = typeof ext.rotation === 'number' ? ext.rotation : 0;
  const texCoord = ext.texCoord === 0 || ext.texCoord === 1 ? ext.texCoord : undefined;

  return Object.freeze({
    offset: Object.freeze([offset[0], offset[1]]) as readonly [number, number],
    scale: Object.freeze([scale[0], scale[1]]) as readonly [number, number],
    rotation,
    ...(texCoord !== undefined ? { texCoord } : {})
  });
}

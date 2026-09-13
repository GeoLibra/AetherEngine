import type { AssetId } from '../../types';

/**
 * Common base interface for all immutable canonical asset documents.
 * Canonical documents are engine-owned, format-agnostic, and self-contained.
 */
export interface CanonicalAssetDocument {
  readonly id: AssetId;
  readonly kind: CanonicalAssetKind;
  readonly version: number;
}

export type CanonicalAssetKind = 'scene' | 'mesh' | 'material' | 'texture' | 'sampler';

/** 3D Axis-Aligned Bounding Box in engine object space (meters). */
export interface Bounds3 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Supported canonical vertex attribute semantics. */
export type CanonicalVertexSemantic =
  'position' | 'normal' | 'tangent' | 'texcoord-0' | 'texcoord-1' | 'color-0';

/** Data format of a canonical vertex attribute. */
export type CanonicalVertexFormat =
  | 'float32'
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'
  | 'uint8x4'
  | 'uint16x2'
  | 'uint16x4'
  | 'unorm8x3'
  | 'unorm8x4'
  | 'unorm16x2'
  | 'unorm16x4';

/** Single canonical vertex attribute stream with typed memory slice. */
export interface CanonicalVertexAttribute {
  readonly semantic: CanonicalVertexSemantic;
  readonly format: CanonicalVertexFormat;
  readonly count: number;
  readonly normalized: boolean;
  readonly data: Uint8Array | Float32Array | Uint16Array | Uint32Array;
  readonly stride?: number;
}

/** Canonical index buffer data for indexed primitives. */
export interface CanonicalIndexData {
  readonly format: 'u16' | 'u32';
  readonly count: number;
  readonly data: Uint16Array | Uint32Array;
}

/** A single geometric surface primitive within a mesh document. */
export interface CanonicalMeshPrimitive {
  readonly topology: 'triangle-list';
  readonly attributes: readonly CanonicalVertexAttribute[];
  readonly indices: CanonicalIndexData | null;
  readonly materialId: AssetId | null;
  readonly bounds: Readonly<Bounds3>;
}

/** Canonical mesh document representing one or more geometry primitives. */
export interface CanonicalMeshDocument extends CanonicalAssetDocument {
  readonly kind: 'mesh';
  readonly name?: string;
  readonly primitives: readonly CanonicalMeshPrimitive[];
}

/** Affine 2D texture UV coordinate transform (KHR_texture_transform compatible). */
export interface TextureUvTransform {
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  readonly texCoord?: 0 | 1;
}

/** Texture attachment slot referencing a canonical texture and sampler. */
export interface CanonicalTextureSlot {
  readonly textureId: AssetId;
  readonly samplerId: AssetId;
  readonly texCoord: 0 | 1;
  readonly transform: Readonly<TextureUvTransform>;
}

/** Normal texture slot with linear scale factor. */
export interface CanonicalNormalTextureSlot extends CanonicalTextureSlot {
  readonly scale: number;
}

/** Ambient occlusion texture slot with linear strength factor. */
export interface CanonicalOcclusionTextureSlot extends CanonicalTextureSlot {
  readonly strength: number;
}

/** Canonical Metallic-Roughness PBR material document. */
export interface CanonicalStandardPbrMaterial extends CanonicalAssetDocument {
  readonly kind: 'material';
  readonly name?: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColorTexture: CanonicalTextureSlot | null;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughnessTexture: CanonicalTextureSlot | null;
  readonly normalTexture: CanonicalNormalTextureSlot | null;
  readonly occlusionTexture: CanonicalOcclusionTextureSlot | null;
  readonly emissiveFactor: readonly [number, number, number];
  readonly emissiveTexture: CanonicalTextureSlot | null;
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
}

/** Source image data or URI reference for a canonical texture. */
export interface CanonicalTextureDocument extends CanonicalAssetDocument {
  readonly kind: 'texture';
  readonly name?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly data?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}

/** Canonical texture sampler document defining filtering and wrapping behavior. */
export interface CanonicalSamplerDocument extends CanonicalAssetDocument {
  readonly kind: 'sampler';
  readonly name?: string;
  readonly magFilter?: 'linear' | 'nearest';
  readonly minFilter?:
    | 'linear'
    | 'nearest'
    | 'linear-mipmap-linear'
    | 'linear-mipmap-nearest'
    | 'nearest-mipmap-linear'
    | 'nearest-mipmap-nearest';
  readonly wrapS: 'repeat' | 'clamp-to-edge' | 'mirrored-repeat';
  readonly wrapT: 'repeat' | 'clamp-to-edge' | 'mirrored-repeat';
}

/** Node transform specified either as TRS components or a 16-element column-major matrix. */
export type CanonicalTransform =
  | {
      readonly kind: 'trs';
      readonly translation: readonly [number, number, number];
      readonly rotation: readonly [number, number, number, number];
      readonly scale: readonly [number, number, number];
    }
  | {
      readonly kind: 'matrix';
      readonly matrix: readonly number[]; // 16 numbers column-major
    };

/** A single node in the canonical scene graph. */
export interface CanonicalNodeDocument {
  readonly name?: string;
  readonly transform: CanonicalTransform;
  readonly meshId?: AssetId;
  readonly children: readonly number[];
  readonly cameraIndex?: number;
  readonly skinIndex?: number;
}

/** Canonical scene document representing the root scene hierarchy and instances. */
export interface CanonicalSceneDocument extends CanonicalAssetDocument {
  readonly kind: 'scene';
  readonly name?: string;
  readonly nodes: readonly CanonicalNodeDocument[];
  readonly rootNodes: readonly number[];
  readonly defaultSceneIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Complete bundle of all canonical assets generated from a single container or scene file. */
export interface CanonicalAssetBundle {
  readonly scene: CanonicalSceneDocument;
  readonly meshes: readonly CanonicalMeshDocument[];
  readonly materials: readonly CanonicalStandardPbrMaterial[];
  readonly textures: readonly CanonicalTextureDocument[];
  readonly samplers: readonly CanonicalSamplerDocument[];
}

import type { MeshData, VertexFormat } from '../../../geometry';
import type { AssetId } from '../../types';
import type { CanonicalAssetDocument } from '../../canonical/types';

/** Role tag for a cooked texture identifying its PBR channel intent. */
export type CookedTextureRole =
  'base-color' | 'metallic-roughness' | 'normal' | 'occlusion' | 'emissive';

/** Shader-level semantic expected by the material binding system. */
export type CookedTextureSemantic = 'color' | 'data' | 'normal';

/** Pixel formats supported for cooked textures. */
export type CookedTextureFormat = 'rgba8unorm' | 'rgba8unorm-srgb' | 'r8unorm';

/** Single cooked vertex attribute stream formatted for standard GPU ABI. */
export interface CookedVertexStream {
  readonly semantic: string;
  readonly format: VertexFormat;
  readonly stride: number;
  readonly offset: number;
  readonly count: number;
  readonly data: Uint8Array | Float32Array | Uint16Array | Uint32Array;
}

/** A single cooked surface primitive with unified standard ABI streams and optimized indices. */
export interface CookedMeshPrimitive {
  readonly primitiveIndex: number;
  readonly materialId: AssetId | null;
  readonly meshData: MeshData;
  readonly hasGeneratedTangents: boolean;
  readonly originalIndexFormat: 'u16' | 'u32' | 'none';
  readonly cookedIndexFormat: 'u16' | 'u32' | 'none';
}

/** Complete cooked mesh artifact containing one or more cooked primitives. */
export interface CookedMeshArtifact extends CanonicalAssetDocument {
  readonly kind: 'mesh';
  readonly primitives: readonly CookedMeshPrimitive[];
  readonly totalByteLength: number;
}

/** Cooked texture payload ready for GPU upload or streaming. */
export interface CookedTextureArtifact extends CanonicalAssetDocument {
  readonly kind: 'texture';
  readonly role: CookedTextureRole;
  readonly semantic: CookedTextureSemantic;
  readonly format: CookedTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly mipCount: number;
}

/** Cooked sampler configuration. */
export interface CookedSamplerArtifact extends CanonicalAssetDocument {
  readonly kind: 'sampler';
  readonly minFilter: 'linear' | 'nearest';
  readonly magFilter: 'linear' | 'nearest';
  readonly mipmapFilter: 'linear' | 'nearest';
  readonly addressModeU: 'repeat' | 'clamp-to-edge' | 'mirrored-repeat';
  readonly addressModeV: 'repeat' | 'clamp-to-edge' | 'mirrored-repeat';
}

/** Cooked scene node with hierarchical world transform and mesh associations. */
export interface CookedSceneNode {
  readonly nodeIndex: number;
  readonly name?: string;
  readonly localTransform: readonly number[]; // 16-element column-major matrix
  readonly worldTransform: readonly number[]; // 16-element column-major matrix
  readonly meshId?: AssetId;
  readonly children: readonly number[];
}

/** Cooked scene artifact ready for hierarchy extraction into ECS World. */
export interface CookedSceneArtifact extends CanonicalAssetDocument {
  readonly kind: 'scene';
  readonly nodes: readonly CookedSceneNode[];
  readonly rootNodes: readonly number[];
  readonly defaultSceneIndex: number;
}

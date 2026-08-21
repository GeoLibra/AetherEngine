import type { MeshBounds } from '../../geometry';
import type { Entity } from '../../ecs/types';

/** Versioned CPU asset identity retained by the render extraction boundary. */
export interface RenderAssetReference {
  readonly assetId: string;
  readonly payloadVersion: number;
}

/** One material slot binding resolved by Scene/Asset Runtime before extraction. */
export interface RenderMaterialBinding extends RenderAssetReference {
  readonly slot: number;
}

/** MainWorld input required to make an entity eligible for standard mesh rendering. */
export interface MeshRenderSourceView {
  readonly mesh: RenderAssetReference;
  readonly submesh: number;
  readonly materials: readonly RenderMaterialBinding[];
  readonly localBounds: MeshBounds;
  readonly visible: boolean;
  readonly layerMask: number;
}

/** Immutable transform fact published into RenderWorld in engine world coordinates. */
export interface RenderTransformFact {
  readonly matrix: readonly number[];
  readonly previousMatrix: readonly number[];
  readonly normalMatrix: readonly number[];
  readonly determinantSign: number;
  readonly worldVersion: number;
}

/** Immutable mesh selection used by Prepare to resolve a device-specific variant. */
export interface RenderMeshFact extends RenderAssetReference {
  readonly submesh: number;
}

/** Visibility intent shared by visibility and phase construction. */
export interface RenderVisibilityFact {
  readonly visible: boolean;
  readonly layerMask: number;
}

/** Input to one atomic MainWorld-to-RenderWorld extraction. */
export interface MeshExtractionInput {
  readonly sourceTick: number;
  readonly transforms: ReadonlyMap<Entity, RenderTransformFact>;
}

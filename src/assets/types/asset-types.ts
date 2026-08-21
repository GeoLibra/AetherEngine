/** Stable namespaced identifier for one canonical CPU asset. */
export type AssetId = string & { readonly __assetId: unique symbol };

/** Stable namespaced asset-kind identity that preserves the payload type parameter. */
export type AssetTypeId<T> = string & { readonly __assetType?: T };

/** Runtime-stable typed reference; payload publication never replaces this identity. */
export interface AssetHandle<T> {
  readonly assetId: AssetId;
  readonly type: AssetTypeId<T>;
}

/** A typed handle paired with the immutable canonical payload version used by a snapshot. */
export interface ResolvedAssetReference<T> {
  readonly handle: AssetHandle<T>;
  readonly payloadVersion: number;
}

/** Marker type for canonical geometry mesh payloads. */
declare const geometryMeshAssetBrand: unique symbol;
export interface GeometryMeshAsset {
  readonly [geometryMeshAssetBrand]: true;
}

/** Marker type for canonical material payloads. */
declare const materialAssetPayloadBrand: unique symbol;
export interface MaterialAssetPayload {
  readonly [materialAssetPayloadBrand]: true;
}

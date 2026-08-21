import type {
  AssetHandle,
  AssetId,
  AssetTypeId,
  GeometryMeshAsset,
  MaterialAssetPayload
} from './types';

const STABLE_ID = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)+$/;

/** Canonical type identity for Geometry/Mesh assets. */
export const MeshAssetType = defineAssetType<GeometryMeshAsset>('asset.geometry-mesh');
/** Canonical type identity for Material assets. */
export const MaterialAssetType = defineAssetType<MaterialAssetPayload>('asset.material');

/** Defines a stable, serializable asset type identity without runtime enum machinery. */
export function defineAssetType<T>(id: string): AssetTypeId<T> {
  if (!STABLE_ID.test(id)) throw new Error('Asset type ID must be a namespaced stable identifier.');
  return id as AssetTypeId<T>;
}

/** Creates a validated immutable handle for one canonical asset identity. */
export function createAssetHandle<T>(type: AssetTypeId<T>, assetId: string): AssetHandle<T> {
  if (!STABLE_ID.test(type)) throw new Error('Asset handle type must be a namespaced stable ID.');
  if (!assetId.trim()) throw new Error('Asset handle ID must be non-empty.');
  return Object.freeze({ assetId: assetId as AssetId, type });
}

/** Validates an untrusted serialized/runtime handle and returns an owned immutable identity. */
export function validateAssetHandle<T>(
  value: unknown,
  expectedType: AssetTypeId<T>,
  label = 'Asset'
): AssetHandle<T> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('assetId' in value) ||
    !('type' in value) ||
    typeof value.assetId !== 'string' ||
    typeof value.type !== 'string'
  ) {
    throw new Error(`${label} handle must contain string assetId and type fields.`);
  }
  if (value.type !== expectedType)
    throw new Error(`${label} handle type must be "${expectedType}".`);
  return createAssetHandle(expectedType, value.assetId);
}

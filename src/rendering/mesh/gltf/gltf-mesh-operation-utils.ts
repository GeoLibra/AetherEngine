import type { CanonicalMeshDocument } from '../../../assets/canonical/types';
import type { GltfImportedBundle } from '../../../assets/importers/gltf';
import type { MergedAssetRequestDemand } from '../../../assets/request-scheduler';
import type { AssetId } from '../../../assets/types';

/** Validates the decoded bundle and selects the request's stable mesh subasset. */
export function selectGltfMesh(
  decoded: unknown,
  request: MergedAssetRequestDemand,
  meshAssetId: AssetId,
  payloadVersion: number
): Readonly<{ bundle: GltfImportedBundle; mesh: CanonicalMeshDocument }> {
  if (request.assetId !== meshAssetId || request.revision !== payloadVersion) {
    throw new Error('glTF mesh request identity does not match the prepared variant.');
  }
  if (!isImportedBundle(decoded)) throw new Error('glTF decode job returned an invalid bundle.');
  const mesh = decoded.meshes.find((entry) => entry.id === meshAssetId);
  if (mesh === undefined) throw new Error(`glTF mesh asset "${meshAssetId}" is absent.`);
  return { bundle: decoded, mesh };
}

function isImportedBundle(value: unknown): value is GltfImportedBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'meshes' in value &&
    Array.isArray(value.meshes) &&
    value.meshes.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'id' in entry &&
        typeof entry.id === 'string' &&
        'primitives' in entry &&
        Array.isArray(entry.primitives)
    ) &&
    'materials' in value &&
    Array.isArray(value.materials)
  );
}

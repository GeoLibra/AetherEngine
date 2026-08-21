import { MeshAssetField, MeshMaterialsField } from './mesh-extraction';
import type { PreparedMesh } from './mesh-prepare';
import type {
  PreparedAssetLease,
  PreparedAssetRegistry,
  PreparedVariantKey
} from './prepared-assets';
import type {
  MeshQueueResolution,
  MeshQueueSkip,
  PreparedMeshQueueCandidate,
  ResolveMeshQueueInput,
  RenderMaterialBinding,
  RenderMeshFact
} from './types';

/** Resolves visible mesh facts to exact prepared mesh/material leases before phase construction. */
export function resolvePreparedMeshQueue(
  registry: PreparedAssetRegistry,
  input: ResolveMeshQueueInput
): MeshQueueResolution {
  if (input.revision.released) throw new Error('Cannot queue a released render revision.');
  validateIdentity(input);
  const candidates: PreparedMeshQueueCandidate[] = [];
  const skipped: MeshQueueSkip[] = [];
  const leases: PreparedAssetLease<unknown>[] = [];
  try {
    for (const visible of input.visibility.items) {
      const fields = input.revision.snapshot.get(visible.renderEntity);
      const meshFact = fields?.get(MeshAssetField) as RenderMeshFact | undefined;
      const materials = fields?.get(MeshMaterialsField) as
        readonly RenderMaterialBinding[] | undefined;
      if (meshFact === undefined || materials === undefined) {
        skipped.push(skip(visible.renderEntity, 'missing-resource', 'missing-render-fact'));
        continue;
      }
      const meshKey = variantKey(
        meshFact.handle.assetId,
        meshFact.payloadVersion,
        input.deviceGeneration,
        input.featurePolicyKey,
        input.meshAbiVersion
      );
      const mesh = registry.acquire<PreparedMesh>(meshKey);
      if (mesh === undefined) {
        skipped.push(skip(visible.renderEntity, 'prepare-pending', 'mesh-prepare-pending'));
        continue;
      }
      leases.push(mesh as PreparedAssetLease<unknown>);
      const submesh = mesh.prepared.value.submeshes[meshFact.submesh];
      if (submesh === undefined) {
        mesh.dispose();
        leases.pop();
        skipped.push(skip(visible.renderEntity, 'incompatible-pipeline', 'invalid-submesh'));
        continue;
      }
      const materialFact = materials.find((binding) => binding.slot === submesh.materialSlot);
      if (materialFact === undefined) {
        mesh.dispose();
        leases.pop();
        skipped.push(skip(visible.renderEntity, 'missing-resource', 'missing-material-slot'));
        continue;
      }
      const material = registry.acquire(
        variantKey(
          materialFact.handle.assetId,
          materialFact.payloadVersion,
          input.deviceGeneration,
          input.featurePolicyKey,
          input.materialAbiVersion
        )
      );
      if (material === undefined) {
        mesh.dispose();
        leases.pop();
        skipped.push(skip(visible.renderEntity, 'prepare-pending', 'material-prepare-pending'));
        continue;
      }
      leases.push(material);
      candidates.push(
        Object.freeze({
          entity: visible.renderEntity,
          depthRange: Object.freeze([...visible.depthRange]) as readonly [number, number],
          submesh: meshFact.submesh,
          mesh,
          material
        })
      );
    }
  } catch (error) {
    for (const lease of leases.reverse()) lease.dispose();
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    candidates: Object.freeze(candidates),
    skipped: Object.freeze(skipped),
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const lease of leases.reverse()) lease.dispose();
    }
  });
}

function variantKey(
  assetId: string,
  payloadVersion: number,
  deviceGeneration: number,
  featurePolicyKey: string,
  abiVersion: string
): PreparedVariantKey {
  return Object.freeze({ assetId, payloadVersion, deviceGeneration, featurePolicyKey, abiVersion });
}

function skip(
  entity: MeshQueueSkip['entity'],
  reason: MeshQueueSkip['reason'],
  code: MeshQueueSkip['code']
): MeshQueueSkip {
  return Object.freeze({ entity, reason, code });
}

function validateIdentity(input: ResolveMeshQueueInput): void {
  if (!Number.isSafeInteger(input.deviceGeneration) || input.deviceGeneration < 0) {
    throw new Error('Mesh queue device generation must be a non-negative safe integer.');
  }
  for (const [label, value] of [
    ['FeaturePolicy key', input.featurePolicyKey],
    ['mesh ABI version', input.meshAbiVersion],
    ['material ABI version', input.materialAbiVersion]
  ] as const) {
    if (!value.trim()) throw new Error(`Mesh queue ${label} must be non-empty.`);
  }
}

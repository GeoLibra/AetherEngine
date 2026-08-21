import { describe, expect, test, vi } from 'vitest';
import {
  MaterialAssetType,
  MeshAssetField,
  MeshAssetType,
  MeshMaterialsField,
  MeshRenderExtractor,
  PreparedAssetRegistry,
  RenderWorld,
  createAssetHandle,
  createMeshRenderExtractorPlan,
  resolvePreparedMeshQueue,
  type PreparedMesh,
  type PreparedVariantKey,
  type RenderEntityId,
  type RenderRevision,
  type ViewVisibilitySnapshot
} from '../../src';

const context = {
  deviceGeneration: 7,
  featurePolicyKey: 'policy-a',
  meshAbiVersion: 'mesh-v1',
  materialAbiVersion: 'material-v1'
} as const;

function key(assetId: string, payloadVersion: number, abiVersion: string): PreparedVariantKey {
  return { assetId, payloadVersion, deviceGeneration: 7, featurePolicyKey: 'policy-a', abiVersion };
}

function createRevision(submesh = 0): { revision: RenderRevision; entity: RenderEntityId } {
  const world = new RenderWorld({ extractorPlan: createMeshRenderExtractorPlan() });
  const tx = world.beginExtract(1, 0);
  const entity = tx.mapEntity('cube');
  const draft = tx.draft(MeshRenderExtractor);
  draft.upsert(entity, MeshAssetField, {
    handle: createAssetHandle(MeshAssetType, 'mesh:cube'),
    payloadVersion: 2,
    submesh
  });
  draft.upsert(entity, MeshMaterialsField, [
    {
      slot: 4,
      handle: createAssetHandle(MaterialAssetType, 'material:default'),
      payloadVersion: 3
    }
  ]);
  return { revision: tx.commit(), entity };
}

function visibility(entity: RenderEntityId): ViewVisibilitySnapshot {
  return {
    viewId: 'main',
    viewRevision: 1,
    source: 'cpu',
    entities: [entity],
    items: [
      { renderEntity: entity, boundsRevision: 1, depthRange: [-2, -1], lod: 0, visibilityFlags: 0 }
    ],
    overflowed: false,
    counters: {
      candidates: 1,
      layerRejected: 0,
      disabledRejected: 0,
      frustumRejected: 0,
      retained: 1,
      planeTests: 6,
      conservativeFallbackRetained: 0
    }
  };
}

function preparedMesh(): PreparedMesh {
  return {
    deviceGeneration: 7,
    layout: { topology: 'triangles', frontFace: 'ccw', streams: [] },
    vertexBuffers: [],
    submeshes: [{ start: 0, count: 3, materialSlot: 4 }],
    byteLength: 0
  };
}

describe('prepared mesh queue resolution', () => {
  test('acquires exact mesh/material variants and retains them until resolution disposal', () => {
    const { revision, entity } = createRevision();
    const registry = new PreparedAssetRegistry();
    const destroyMesh = vi.fn();
    const destroyMaterial = vi.fn();
    const meshKey = key('mesh:cube', 2, 'mesh-v1');
    const materialKey = key('material:default', 3, 'material-v1');
    registry.publish({ key: meshKey, value: preparedMesh() }, destroyMesh);
    registry.publish({ key: materialKey, value: { pipeline: 'ready' } }, destroyMaterial);

    const result = resolvePreparedMeshQueue(registry, {
      revision,
      visibility: visibility(entity),
      ...context
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    registry.retire(meshKey);
    registry.retire(materialKey);
    expect(destroyMesh).not.toHaveBeenCalled();
    result.dispose();
    expect(destroyMesh).toHaveBeenCalledOnce();
    expect(destroyMaterial).toHaveBeenCalledOnce();
    revision.release();
  });

  test('reports typed pending and compatibility skip reasons without leaking leases', () => {
    const missing = createRevision();
    const registry = new PreparedAssetRegistry();
    expect(
      resolvePreparedMeshQueue(registry, {
        revision: missing.revision,
        visibility: visibility(missing.entity),
        ...context
      }).skipped
    ).toEqual([
      { entity: missing.entity, reason: 'prepare-pending', code: 'mesh-prepare-pending' }
    ]);
    missing.revision.release();

    const invalid = createRevision(2);
    const meshKey = key('mesh:cube', 2, 'mesh-v1');
    const destroy = vi.fn();
    registry.publish({ key: meshKey, value: preparedMesh() }, destroy);
    const result = resolvePreparedMeshQueue(registry, {
      revision: invalid.revision,
      visibility: visibility(invalid.entity),
      ...context
    });
    expect(result.skipped).toEqual([
      { entity: invalid.entity, reason: 'incompatible-pipeline', code: 'invalid-submesh' }
    ]);
    registry.retire(meshKey);
    expect(destroy).toHaveBeenCalledOnce();
    invalid.revision.release();
  });

  test('rejects released revisions', () => {
    const { revision, entity } = createRevision();
    revision.release();
    expect(() =>
      resolvePreparedMeshQueue(new PreparedAssetRegistry(), {
        revision,
        visibility: visibility(entity),
        ...context
      })
    ).toThrow(/released render revision/i);
  });
});

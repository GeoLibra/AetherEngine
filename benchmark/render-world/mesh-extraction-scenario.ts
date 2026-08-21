import {
  MaterialAssetType,
  MeshRenderExtraction,
  MeshRenderSource,
  MeshAssetType,
  MeshAssetField,
  MeshMaterialsField,
  MeshRenderExtractor,
  PreparedAssetRegistry,
  MeshTransformField,
  RenderWorld,
  World,
  WorldTransform,
  createAssetHandle,
  createMeshRenderExtractorPlan,
  resolvePreparedMeshQueue,
  type Entity,
  type RenderTransformFact
} from '../../src';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export interface MeshExtractionResult {
  readonly entities: number;
  readonly changes: number;
  readonly translationChecksum: number;
}

export function runMeshExtractionSubject(size: number): MeshExtractionResult {
  const main = new World();
  main.registerComponent(WorldTransform).registerComponent(MeshRenderSource);
  const render = new RenderWorld({ extractorPlan: createMeshRenderExtractorPlan() });
  const extraction = new MeshRenderExtraction(main, render);
  const transforms = new Map<Entity, RenderTransformFact>();
  for (let index = 0; index < size; index += 1) {
    const entity = main
      .spawn()
      .insert(WorldTransform, {
        matrix: IDENTITY,
        previousMatrix: IDENTITY,
        normalMatrix: IDENTITY.slice(0, 9),
        worldVersion: 1,
        originCell: [0, 0, 0],
        determinantSign: 1
      })
      .insert(MeshRenderSource, {
        mesh: {
          handle: createAssetHandle(MeshAssetType, `mesh:${index % 8}`),
          payloadVersion: 1
        },
        submesh: 0,
        materials: [
          {
            slot: 0,
            handle: createAssetHandle(MaterialAssetType, `material:${index % 16}`),
            payloadVersion: 1
          }
        ],
        localBounds: {
          aabb: { min: [-1, -1, -1], max: [1, 1, 1] },
          sphere: { center: [0, 0, 0], radius: Math.sqrt(3) }
        },
        visible: true,
        layerMask: 1
      })
      .build();
    const matrix = [...IDENTITY];
    matrix[12] = index;
    transforms.set(entity, {
      matrix,
      previousMatrix: matrix,
      normalMatrix: IDENTITY.slice(0, 9),
      determinantSign: 1,
      worldVersion: 1
    });
  }
  const revision = extraction.extract({ sourceTick: 1, transforms });
  let translationChecksum = 0;
  for (const fields of revision.snapshot.values()) {
    translationChecksum += (fields.get(MeshTransformField) as RenderTransformFact).matrix[12]!;
  }
  const result = {
    entities: revision.snapshot.size,
    changes: revision.diff.changes.length,
    translationChecksum
  };
  revision.release();
  extraction.dispose();
  return result;
}

/** Independent scalar oracle for the deterministic first-publish workload. */
export function meshExtractionReference(size: number): MeshExtractionResult {
  return {
    entities: size,
    changes: size,
    translationChecksum: (size * (size - 1)) / 2
  };
}

export function runPreparedMeshQueueSubject(size: number): number {
  const render = new RenderWorld({ extractorPlan: createMeshRenderExtractorPlan() });
  const tx = render.beginExtract(1, 0);
  const entities = [];
  for (let index = 0; index < size; index += 1) {
    const entity = tx.mapEntity(`queue:${index}`);
    const draft = tx.draft(MeshRenderExtractor);
    draft.upsert(entity, MeshAssetField, {
      handle: createAssetHandle(MeshAssetType, `mesh:${index % 8}`),
      payloadVersion: 1,
      submesh: 0
    });
    draft.upsert(entity, MeshMaterialsField, [
      {
        slot: 0,
        handle: createAssetHandle(MaterialAssetType, `material:${index % 16}`),
        payloadVersion: 1
      }
    ]);
    entities.push(entity);
  }
  const revision = tx.commit();
  const registry = new PreparedAssetRegistry();
  for (let index = 0; index < 8; index += 1) {
    registry.publish({
      key: queueKey(`mesh:${index}`, 'mesh-v1'),
      value: {
        deviceGeneration: 1,
        layout: { topology: 'triangles' as const, frontFace: 'ccw' as const, streams: [] },
        vertexBuffers: [],
        submeshes: [{ start: 0, count: 3, materialSlot: 0 }],
        byteLength: 0
      }
    });
  }
  for (let index = 0; index < 16; index += 1) {
    registry.publish({ key: queueKey(`material:${index}`, 'material-v1'), value: index });
  }
  const result = resolvePreparedMeshQueue(registry, {
    revision,
    visibility: {
      viewId: 'benchmark',
      viewRevision: 1,
      source: 'cpu',
      entities,
      items: entities.map((renderEntity) => ({
        renderEntity,
        boundsRevision: 1,
        depthRange: [-2, -1] as const,
        lod: 0,
        visibilityFlags: 0
      })),
      overflowed: false,
      counters: {
        candidates: size,
        layerRejected: 0,
        disabledRejected: 0,
        frustumRejected: 0,
        retained: size,
        planeTests: size * 6,
        conservativeFallbackRetained: 0
      }
    },
    deviceGeneration: 1,
    featurePolicyKey: 'benchmark-policy',
    meshAbiVersion: 'mesh-v1',
    materialAbiVersion: 'material-v1'
  });
  const count = result.candidates.length;
  result.dispose();
  revision.release();
  return count;
}

function queueKey(assetId: string, abiVersion: string) {
  return {
    assetId,
    payloadVersion: 1,
    deviceGeneration: 1,
    featurePolicyKey: 'benchmark-policy',
    abiVersion
  };
}

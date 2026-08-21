import {
  MeshRenderExtraction,
  MeshRenderSource,
  MeshTransformField,
  RenderWorld,
  World,
  WorldTransform,
  createMeshRenderExtractorPlan,
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
        mesh: { assetId: `mesh:${index % 8}`, payloadVersion: 1 },
        submesh: 0,
        materials: [{ slot: 0, assetId: `material:${index % 16}`, payloadVersion: 1 }],
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

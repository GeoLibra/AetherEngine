import { bench, expect } from 'vitest';
import {
  RenderExtractorRegistryBuilder,
  RenderWorld,
  PreparedAssetRegistry,
  defineExtractorToken,
  defineRenderField
} from '../src/rendering';
import {
  createRenderPhaseWorkload,
  createPhaseConstructionWorkload,
  runPhaseConstructionSubject,
  runRenderPhaseReference,
  runRenderPhaseSubject
} from './render-world/render-phase-scenario';
import {
  meshExtractionReference,
  runPreparedMeshQueueSubject,
  runMeshExtractionSubject
} from './render-world/mesh-extraction-scenario';
import {
  cameraExtractionReference,
  runCameraExtractionSubject
} from './render-world/camera-extraction-scenario';

const Position = defineRenderField<[number, number, number]>('position');
const Visible = defineRenderField<boolean>('visible');
const Scene = defineExtractorToken('benchmark-scene', [Position, Visible]);
const extractorPlan = new RenderExtractorRegistryBuilder().registerExtractor(Scene).build();
const SnapshotBytes = defineRenderField<Float32Array>('snapshot-bytes');
const SnapshotOwner = defineExtractorToken('snapshot-owner', [SnapshotBytes]);
const snapshotExtractorPlan = new RenderExtractorRegistryBuilder()
  .registerExtractor(SnapshotOwner)
  .build();

for (const size of [1, 8, 32]) {
  const reference = cameraExtractionReference(size);
  bench(
    `extracts and binds ${size} camera surface views`,
    () => expect(runCameraExtractionSubject(size)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const phase of ['opaque', 'transparent'] as const) {
  for (const size of [100, 1_000, 10_000]) {
    const workload = createRenderPhaseWorkload(size, phase);
    const reference = runRenderPhaseReference(workload);
    bench(
      `render phase ${phase} ${size} items`,
      () => expect(runRenderPhaseSubject(workload)).toEqual(reference),
      { iterations: 1, warmupIterations: 0 }
    );
  }
}

for (const size of [1_000, 10_000]) {
  const workload = createPhaseConstructionWorkload(size);
  bench(
    `constructs ${size} resolved material phase candidates`,
    () =>
      expect(runPhaseConstructionSubject(workload)).toMatchObject({
        items: workload.expectedItems,
        skips: workload.expectedSkips,
        ownershipTransfers: 0
      }),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const size of [100, 1_000]) {
  bench(
    `resolves ${size} visible mesh prepared variants`,
    () => expect(runPreparedMeshQueueSubject(size)).toBe(size),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const size of [100, 1_000, 10_000]) {
  bench(
    `retires ${size} prepared assets by exact policy hash`,
    () => {
      const registry = new PreparedAssetRegistry();
      let destroyed = 0;
      for (let index = 0; index < size; index++) {
        registry.publish(
          {
            key: {
              assetId: `asset-${index}`,
              payloadVersion: 1,
              deviceGeneration: 1,
              featurePolicyKey: index % 2 === 0 ? 'old-policy' : 'other-policy',
              abiVersion: 'benchmark-v1'
            },
            value: index
          },
          () => {
            destroyed++;
          }
        );
      }
      registry.invalidateFeaturePolicy({
        domain: 'prepared-asset',
        previousHash: 'old-policy',
        nextHash: 'next-policy'
      });
      expect(destroyed).toBe(Math.ceil(size / 2));
      expect(
        registry.acquire({
          assetId: 'asset-1',
          payloadVersion: 1,
          deviceGeneration: 1,
          featurePolicyKey: 'other-policy',
          abiVersion: 'benchmark-v1'
        })?.prepared.value
      ).toBe(1);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const size of [100, 1_000]) {
  const reference = meshExtractionReference(size);
  bench(
    `extracts ${size} canonical mesh entities from MainWorld`,
    () => expect(runMeshExtractionSubject(size)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const size of [100, 1_000, 10_000]) {
  bench(
    `publishes ${size} render entities with deterministic diff`,
    () => {
      const world = new RenderWorld({ requiredFields: [Position], extractorPlan });
      const first = world.beginExtract(1, 0);
      for (let index = 0; index < size; index++) {
        const entity = first.mapEntity(index);
        first.draft(Scene).upsert(entity, Position, [index, 0, 0]);
      }
      const revision = first.commit();
      expect(revision.diff.changes).toHaveLength(size);
      expect(revision.snapshot.size).toBe(size);
      revision.release();
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const incrementalWorld = new RenderWorld({ requiredFields: [Position], extractorPlan });
const initial = incrementalWorld.beginExtract(1, 0);
for (let index = 0; index < 10_000; index++) {
  initial.draft(Scene).upsert(initial.mapEntity(index), Position, [index, 0, 0]);
}
initial.commit().release();
const stableEntity = incrementalWorld.mapEntity(9_999);
const stableRevision = incrementalWorld.snapshot();
const stableFields = stableRevision.snapshot.get(stableEntity);
stableRevision.release();
let incrementalTick = 1;

bench(
  'updates one entity in a 10000-entity revision with structural sharing',
  () => {
    incrementalTick++;
    const transaction = incrementalWorld.beginExtract(incrementalTick, incrementalTick - 1);
    transaction
      .draft(Scene)
      .upsert(incrementalWorld.mapEntity(0), Position, [incrementalTick, 0, 0]);
    const revision = transaction.commit();
    expect(revision.diff.changes).toHaveLength(1);
    expect(revision.snapshot.get(stableEntity)).toBe(stableFields);
    expect(incrementalWorld.counters).toMatchObject({
      copiedDirectoryNodes: 2,
      copiedPages: 1,
      comparedFields: 1
    });
    revision.release();
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const size of [100, 1_000, 10_000]) {
  const workload = createFrozenMapReadWorkload(size);
  bench(
    `reads ${size} FrozenMap fields through detached public copies`,
    () => {
      const revision = workload.world.snapshot();
      let checksum = 0;
      for (const entity of workload.entities) {
        const bytes = revision.snapshot.get(entity)!.get(SnapshotBytes)! as Float32Array;
        checksum += bytes[0]! + bytes[1]!;
        bytes[0] = -1;
      }
      revision.release();
      expect(checksum).toBe(workload.expectedChecksum);
      expect(workload.world.read(workload.entities[0]!, SnapshotBytes)![0]).toBe(0);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

function createFrozenMapReadWorkload(size: number): Readonly<{
  world: RenderWorld;
  entities: readonly ReturnType<RenderWorld['mapEntity']>[];
  expectedChecksum: number;
}> {
  const world = new RenderWorld({ extractorPlan: snapshotExtractorPlan });
  const transaction = world.beginExtract(1, 0);
  const entities: ReturnType<RenderWorld['mapEntity']>[] = [];
  let expectedChecksum = 0;
  for (let index = 0; index < size; index++) {
    const entity = transaction.mapEntity(`frozen-field-${index}`);
    transaction.draft(SnapshotOwner).upsert(entity, SnapshotBytes, new Float32Array([index, 1]));
    entities.push(entity);
    expectedChecksum += index + 1;
  }
  transaction.commit().release();
  return Object.freeze({ world, entities: Object.freeze(entities), expectedChecksum });
}

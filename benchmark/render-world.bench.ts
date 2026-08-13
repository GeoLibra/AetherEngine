import { bench, expect } from 'vitest';
import {
  RenderExtractorRegistryBuilder,
  RenderWorld,
  defineExtractorToken,
  defineRenderField
} from '../src/rendering';

const Position = defineRenderField<[number, number, number]>('position');
const Visible = defineRenderField<boolean>('visible');
const Scene = defineExtractorToken('benchmark-scene', [Position, Visible]);
const extractorPlan = new RenderExtractorRegistryBuilder().registerExtractor(Scene).build();

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

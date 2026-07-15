import { bench, expect } from 'vitest';
import { RenderWorld, defineExtractorToken, defineRenderField } from '../src/rendering';

const Position = defineRenderField<[number, number, number]>('position');
const Visible = defineRenderField<boolean>('visible');
const Scene = defineExtractorToken('benchmark-scene', [Position, Visible]);

for (const size of [100, 1_000, 10_000]) {
  bench(`publishes ${size} render entities with deterministic diff`, () => {
    const world = new RenderWorld({ requiredFields: [Position] });
    const first = world.beginExtract(1, 0);
    for (let index = 0; index < size; index++) {
      const entity = first.mapEntity(index);
      first.draft(Scene).upsert(entity, Position, [index, 0, 0]);
    }
    const revision = first.commit();
    expect(revision.diff.changes).toHaveLength(size);
    expect(revision.snapshot.size).toBe(size);
  }, { iterations: 1, warmupIterations: 0 });
}

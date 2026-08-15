import { bench, expect } from 'vitest';
import { TransformRuntime, World, type Entity } from '../src';

interface TransformExtractWorkload {
  readonly runtime: TransformRuntime;
  readonly entities: readonly Entity[];
  readonly expectedChecksum: number;
}

for (const count of [100, 1_000, 10_000]) {
  const workload = createTransformExtractWorkload(count);
  bench(
    `extracts ${count} detached transform matrices`,
    () => {
      const snapshots = workload.runtime.extract({ interpolationAlpha: 0.5 });
      let checksum = 0;
      for (const entity of workload.entities) {
        const snapshot = snapshots.get(entity)!;
        checksum += snapshot.matrix[12]! + snapshot.previousMatrix[12]! + snapshot.normalMatrix[0]!;
      }
      expect(snapshots.size).toBe(count);
      expect(checksum).toBe(workload.expectedChecksum);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

function createTransformExtractWorkload(count: number): TransformExtractWorkload {
  const world = new World();
  const runtime = TransformRuntime.install(world);
  const entities: Entity[] = [];
  let expectedChecksum = 0;
  for (let index = 0; index < count; index++) {
    const entity = world.spawn().build();
    const x = index * 0.25;
    runtime.attach(entity, { translation: [x, index % 3, -index % 7] });
    entities.push(entity);
    expectedChecksum += x * 2 + 1;
  }
  const propagated = runtime.propagate();
  if (propagated.propagated !== count) {
    throw new Error(
      `Transform benchmark setup propagated ${propagated.propagated}, expected ${count}.`
    );
  }
  return Object.freeze({ runtime, entities: Object.freeze(entities), expectedChecksum });
}

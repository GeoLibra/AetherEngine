import { TransformRuntime, World, type Entity } from '../src';

export interface TransformExtractWorkload {
  readonly runtime: TransformRuntime;
  readonly entities: readonly Entity[];
  readonly expected: Readonly<{ count: number; checksum: number }>;
}

/**
 * Independent scalar oracle: initial history is identity, so alpha 0.5 yields x / 2 in the
 * extracted matrix, zero previous translation, and one normal diagonal contribution per entity.
 */
export function createTransformExtractWorkload(count: number): TransformExtractWorkload {
  const world = new World();
  const runtime = TransformRuntime.install(world);
  const entities: Entity[] = [];
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    const entity = world.spawn().build();
    const x = index * 0.25;
    runtime.attach(entity, { translation: [x, index % 3, -index % 7] });
    entities.push(entity);
    checksum += x * 0.5 + 1;
  }
  const propagated = runtime.propagate();
  if (propagated.propagated !== count) {
    throw new Error(
      `Transform benchmark setup propagated ${propagated.propagated}, expected ${count}.`
    );
  }
  return Object.freeze({
    runtime,
    entities: Object.freeze(entities),
    expected: Object.freeze({ count, checksum })
  });
}

export function runTransformExtractSubject(
  workload: TransformExtractWorkload
): Readonly<{ count: number; checksum: number }> {
  const snapshots = workload.runtime.extract({ interpolationAlpha: 0.5 });
  let checksum = 0;
  for (const entity of workload.entities) {
    const snapshot = snapshots.get(entity);
    if (!snapshot) throw new Error(`Transform benchmark lost entity ${entity}.`);
    checksum += snapshot.matrix[12]! + snapshot.previousMatrix[12]! + snapshot.normalMatrix[0]!;
  }
  return Object.freeze({ count: snapshots.size, checksum });
}

export function assertTransformExtractPreflight(
  workload: TransformExtractWorkload
): Readonly<{ count: number; checksum: number }> {
  const result = runTransformExtractSubject(workload);
  if (
    result.count !== workload.expected.count ||
    result.checksum !== workload.expected.checksum ||
    !Number.isFinite(result.checksum) ||
    result.count === 0
  ) {
    throw new Error(
      'Transform extraction benchmark preflight failed its finite independent oracle.'
    );
  }
  return result;
}

import { bench, expect } from 'vitest';
import { Schedule, World } from '../src';
import {
  createQueuedJobFixture,
  referenceQueueOrder,
  subjectQueueOrder
} from './runtime-jobs/model';
import {
  runRuntimeIntegrityReference,
  runRuntimeIntegritySubject
} from './runtime-jobs/integrity-scenarios';

const queueFixture = createQueuedJobFixture(2_048);
const expectedQueueOrder = referenceQueueOrder(queueFixture);

bench(
  'orders 2K mixed-priority jobs against the stable reference oracle',
  () => {
    expect(subjectQueueOrder(queueFixture)).toEqual(expectedQueueOrder);
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const scale of [32, 256, 1_024]) {
  const reference = runRuntimeIntegrityReference(scale);
  bench(
    `executes command/event/state/metrics integrity lanes at scale ${scale}`,
    () => {
      const subject = runRuntimeIntegritySubject(scale);
      expect(subject).toEqual(reference);
      expect(subject.counters.appliedCommands).toBe(scale);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

bench(
  'builds and runs a deterministic 1K-system schedule',
  () => {
    const schedule = new Schedule('benchmark-runtime');
    const world = new World();
    let executed = 0;
    for (let index = 0; index < 1_000; index++) {
      schedule.addSystem({
        id: `system-${index}`,
        ...(index === 0 ? {} : { after: [`system-${index - 1}`] }),
        run: () => {
          executed += 1;
        }
      });
    }
    schedule.runSync(world);
    expect(executed).toBe(1_000);
  },
  { iterations: 1, warmupIterations: 0 }
);

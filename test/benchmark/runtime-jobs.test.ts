import { describe, expect, test } from 'vitest';
import {
  createQueuedJobFixture,
  referenceQueueOrder,
  subjectQueueOrder
} from '../../benchmark/runtime-jobs/model';
import {
  runRuntimeIntegrityReference,
  runRuntimeIntegritySubject
} from '../../benchmark/runtime-jobs/integrity-scenarios';

describe('runtime/jobs benchmark model', () => {
  test('matches the independent stable queue ordering oracle', () => {
    const fixture = createQueuedJobFixture(2_048);
    expect(subjectQueueOrder(fixture)).toEqual(referenceQueueOrder(fixture));
  });

  test('generates the same fixture for the same requested scale', () => {
    expect(createQueuedJobFixture(64)).toEqual(createQueuedJobFixture(64));
  });

  test('executes command, event, state, and metrics lanes across the declared scale axis', () => {
    for (const scale of [8, 64, 256]) {
      const subject = runRuntimeIntegritySubject(scale);

      expect(subject).toEqual(runRuntimeIntegrityReference(scale));
      expect(subject.counters).toEqual({
        clonedBundleEntries: scale,
        appliedCommands: scale,
        publishedEvents: scale,
        stateRequests: scale,
        metricsUpdates: scale
      });
      expect(subject.checksum).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

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

import {
  runScheduleSystemSetReference,
  runScheduleSystemSetSubject
} from '../../benchmark/runtime-jobs/schedule-scenarios';

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

  test('executes schedule SystemSet fanout and condition evaluation matching closed-form oracle', async () => {
    for (const scale of [4, 16]) {
      const subject = await runScheduleSystemSetSubject(scale);
      const reference = runScheduleSystemSetReference(scale);
      expect(subject).toEqual(reference);
      expect(subject.conditionEvaluations).toBe(scale);
      expect(subject.executedCount).toBe((scale / 2) * 4);
    }
  });
});

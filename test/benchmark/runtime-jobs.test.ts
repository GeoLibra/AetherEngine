import { describe, expect, test } from 'vitest';
import {
  createQueuedJobFixture,
  referenceQueueOrder,
  subjectQueueOrder
} from '../../benchmark/runtime-jobs/model';

describe('runtime/jobs benchmark model', () => {
  test('matches the independent stable queue ordering oracle', () => {
    const fixture = createQueuedJobFixture(2_048);
    expect(subjectQueueOrder(fixture)).toEqual(referenceQueueOrder(fixture));
  });

  test('generates the same fixture for the same requested scale', () => {
    expect(createQueuedJobFixture(64)).toEqual(createQueuedJobFixture(64));
  });
});

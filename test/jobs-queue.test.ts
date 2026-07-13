import { describe, expect, test } from 'vitest';
import { sortQueuedJobs, type QueuedJobOrder } from '../src/jobs/queue';

function queued(overrides: Partial<QueuedJobOrder>): QueuedJobOrder {
  return {
    budgetClass: 'background', priority: 0, submittedAt: 0, sequence: 0,
    ...overrides
  };
}

describe('job queue ordering', () => {
  test('uses bounded aging while preserving deterministic tie breaking', () => {
    const backgroundFirst = queued({ sequence: 1, submittedAt: 0 });
    const interactive = queued({ budgetClass: 'interactive', sequence: 2, submittedAt: 9_000 });
    const backgroundSecond = queued({ sequence: 3, submittedAt: 9_000 });

    const ordered = sortQueuedJobs(
      [backgroundSecond, interactive, backgroundFirst], 10_000,
      { agingIntervalMs: 1_000, agingStep: 25, maxAgingBoost: 250 }
    );

    expect(ordered.map((job) => job.sequence)).toEqual([1, 2, 3]);
  });

  test('orders streaming deadlines, screen-space error, then submission sequence', () => {
    const ordered = sortQueuedJobs([
      queued({ budgetClass: 'streaming', deadlineMs: 20, screenSpaceError: 2, sequence: 3 }),
      queued({ budgetClass: 'streaming', deadlineMs: 10, screenSpaceError: 1, sequence: 2 }),
      queued({ budgetClass: 'streaming', deadlineMs: 10, screenSpaceError: 4, sequence: 1 })
    ], 0);

    expect(ordered.map((job) => job.sequence)).toEqual([1, 2, 3]);
  });
});

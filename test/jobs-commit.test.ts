import { describe, expect, test } from 'vitest';
import { CommitQueue } from '../src/jobs/commit-queue';

describe('job commit queue', () => {
  test('commits by stable key, suppresses stale output, and respects cost budget', () => {
    const committed: string[] = [];
    const queue = new CommitQueue();
    queue.enqueue(entry('b', 1, true, committed));
    queue.enqueue(entry('a', 1, false, committed));
    queue.enqueue(entry('c', 2, true, committed));

    expect(queue.drain({ maxCost: 2 })).toEqual({
      committed: 1, stale: 1, deferred: 1, cost: 1, outputBytes: 1
    });
    expect(committed).toEqual(['b']);
  });
});

function entry(key: string, cost: number, current: boolean, committed: string[]) {
  return {
    requestKey: key, output: key, estimatedCost: cost, outputBytes: 1,
    isCurrent: () => current, commit: (output: string) => committed.push(output)
  };
}

import { describe, expect, test } from 'vitest';
import { CommitQueue } from '../../src/jobs/commit-queue';

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

  test('preserves prototype methods on class-based commit entries', () => {
    const committed: string[] = [];
    const queue = new CommitQueue();
    queue.enqueue(new ClassCommitEntry('class-entry', committed));

    expect(queue.drain({ maxCost: 1 })).toMatchObject({ committed: 1 });
    expect(committed).toEqual(['class-entry']);
  });

  test('orders request keys by locale-independent UTF-16 code units', () => {
    const committed: string[] = [];
    const queue = new CommitQueue();
    queue.enqueue(entry('a', 1, true, committed));
    queue.enqueue(entry('B', 1, true, committed));

    queue.drain({ maxCost: 2 });

    expect(committed).toEqual(['B', 'a']);
  });
});

class ClassCommitEntry {
  readonly output: string;
  readonly estimatedCost = 1;
  readonly outputBytes = 1;

  constructor(
    readonly requestKey: string,
    private readonly committed: string[]
  ) {
    this.output = requestKey;
  }

  isCurrent(): boolean { return true; }
  commit(output: string): void { this.committed.push(output); }
}

function entry(key: string, cost: number, current: boolean, committed: string[]) {
  return {
    requestKey: key, output: key, estimatedCost: cost, outputBytes: 1,
    isCurrent: () => current, commit: (output: string) => committed.push(output)
  };
}

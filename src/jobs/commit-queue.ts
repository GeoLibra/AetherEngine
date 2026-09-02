import type { CommitBudget, CommitDrainResult, JobClock, JobCommitEntry } from './types';

interface StoredCommit {
  readonly entry: JobCommitEntry<unknown>;
  readonly sequence: number;
  readonly enqueuedAt: number;
}

export class CommitQueue {
  private readonly entries: StoredCommit[] = [];
  private nextSequence = 0;
  private drainedLatency = 0;

  constructor(private readonly clock: JobClock = { now: () => 0 }) {}

  get length(): number {
    return this.entries.length;
  }

  enqueue<T>(entry: JobCommitEntry<T>): void {
    if (entry.requestKey.trim() === '') {
      throw new Error('Job commit requestKey must not be empty.');
    }
    assertNonNegative(entry.estimatedCost, 'estimatedCost');
    assertNonNegative(entry.outputBytes, 'outputBytes');
    this.entries.push({
      entry: snapshotEntry(entry) as JobCommitEntry<unknown>,
      sequence: this.nextSequence++,
      enqueuedAt: this.clock.now()
    });
  }

  drain(budget: CommitBudget): CommitDrainResult {
    assertNonNegative(budget.maxCost, 'maxCost');
    const ordered = [...this.entries].sort(
      (left, right) =>
        compareRequestKeys(left.entry.requestKey, right.entry.requestKey) ||
        left.sequence - right.sequence
    );
    let committed = 0;
    let stale = 0;
    let cost = 0;
    let outputBytes = 0;
    let processed = 0;
    const removed = new Set<StoredCommit>();
    for (const stored of ordered) {
      if (!stored.entry.isCurrent()) {
        stale++;
        processed++;
        removed.add(stored);
        continue;
      }
      if (cost + stored.entry.estimatedCost > budget.maxCost) break;
      stored.entry.commit(stored.entry.output);
      committed++;
      processed++;
      cost += stored.entry.estimatedCost;
      outputBytes += stored.entry.outputBytes;
      this.drainedLatency += Math.max(0, this.clock.now() - stored.enqueuedAt);
      removed.add(stored);
    }
    this.removeAll(removed);
    return Object.freeze({
      committed,
      stale,
      deferred: ordered.length - processed,
      cost,
      outputBytes
    });
  }

  takeDrainedLatency(): number {
    const value = this.drainedLatency;
    this.drainedLatency = 0;
    return value;
  }

  private removeAll(removed: ReadonlySet<StoredCommit>): void {
    let writeIndex = 0;
    for (const stored of this.entries) {
      if (!removed.has(stored)) {
        this.entries[writeIndex++] = stored;
      }
    }
    this.entries.length = writeIndex;
  }
}

function snapshotEntry<T>(entry: JobCommitEntry<T>): JobCommitEntry<T> {
  return Object.freeze({
    requestKey: entry.requestKey,
    output: entry.output,
    estimatedCost: entry.estimatedCost,
    outputBytes: entry.outputBytes,
    isCurrent: entry.isCurrent.bind(entry),
    commit: entry.commit.bind(entry)
  });
}

function compareRequestKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Job commit ${label} must be a non-negative finite number.`);
  }
}

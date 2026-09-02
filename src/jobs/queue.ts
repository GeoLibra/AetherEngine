import type { JobBudgetClass } from './types';

export interface QueuedJobOrder {
  readonly budgetClass: JobBudgetClass;
  readonly priority: number;
  readonly submittedAt: number;
  readonly deadlineMs?: number;
  readonly screenSpaceError?: number;
  readonly sequence: number;
}

export interface QueuePolicy {
  readonly agingIntervalMs: number;
  readonly agingStep: number;
  readonly maxAgingBoost: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = Object.freeze({
  agingIntervalMs: 1_000,
  agingStep: 10,
  maxAgingBoost: 150
});

export function sortQueuedJobs<T extends QueuedJobOrder>(
  jobs: readonly T[],
  now: number,
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY
): T[] {
  return [...jobs].sort((left, right) => compareQueuedJobs(left, right, now, policy));
}

export function compareQueuedJobs(
  left: QueuedJobOrder,
  right: QueuedJobOrder,
  now: number,
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY
): number {
  const score = effectiveScore(right, now, policy) - effectiveScore(left, now, policy);
  if (score !== 0) return score;
  if (left.budgetClass === 'streaming' && right.budgetClass === 'streaming') {
    const deadline = (left.deadlineMs ?? Infinity) - (right.deadlineMs ?? Infinity);
    if (deadline !== 0) return deadline;
    const sse = (right.screenSpaceError ?? -Infinity) - (left.screenSpaceError ?? -Infinity);
    if (sse !== 0) return sse;
  }
  return left.sequence - right.sequence;
}

function effectiveScore(job: QueuedJobOrder, now: number, policy: QueuePolicy): number {
  const classRank =
    job.budgetClass === 'interactive' ? 200 : job.budgetClass === 'streaming' ? 100 : 0;
  const age = Math.max(0, now - job.submittedAt);
  const aging = Math.min(
    policy.maxAgingBoost,
    Math.floor(age / policy.agingIntervalMs) * policy.agingStep
  );
  return classRank + job.priority + aging;
}

import {
  DEFAULT_QUEUE_POLICY,
  sortQueuedJobs,
  type QueuedJobOrder,
  type QueuePolicy
} from '../../src/jobs/queue';

export const RUNTIME_JOBS_NOW = 60_000;

export function createQueuedJobFixture(count: number): readonly QueuedJobOrder[] {
  let state = 0x6d2b79f5;
  const jobs: QueuedJobOrder[] = [];
  for (let sequence = 0; sequence < count; sequence++) {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    const random = (state ^ (state >>> 14)) >>> 0;
    const classIndex = random % 3;
    jobs.push(
      Object.freeze({
        budgetClass:
          classIndex === 0 ? 'interactive' : classIndex === 1 ? 'streaming' : 'background',
        priority: (random >>> 3) % 101,
        submittedAt: (random >>> 10) % RUNTIME_JOBS_NOW,
        ...(classIndex === 1
          ? {
              deadlineMs: (random >>> 5) % 10_000,
              screenSpaceError: (random >>> 7) % 512
            }
          : {}),
        sequence
      })
    );
  }
  return Object.freeze(jobs);
}

export function subjectQueueOrder(
  jobs: readonly QueuedJobOrder[],
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY
): readonly number[] {
  return sortQueuedJobs(jobs, RUNTIME_JOBS_NOW, policy).map((job) => job.sequence);
}

export function referenceQueueOrder(
  jobs: readonly QueuedJobOrder[],
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY
): readonly number[] {
  return jobs
    .map((job) => ({ job, key: referenceKey(job, policy) }))
    .sort((left, right) => {
      const score = right.key.score - left.key.score;
      if (score !== 0) return score;
      if (left.job.budgetClass === 'streaming' && right.job.budgetClass === 'streaming') {
        const deadline = left.key.deadline - right.key.deadline;
        if (deadline !== 0) return deadline;
        const sse = right.key.screenSpaceError - left.key.screenSpaceError;
        if (sse !== 0) return sse;
      }
      return left.job.sequence - right.job.sequence;
    })
    .map(({ job }) => job.sequence);
}

function referenceKey(job: QueuedJobOrder, policy: QueuePolicy) {
  const classScore =
    job.budgetClass === 'interactive' ? 200 : job.budgetClass === 'streaming' ? 100 : 0;
  const age = Math.max(0, RUNTIME_JOBS_NOW - job.submittedAt);
  const aging = Math.min(
    policy.maxAgingBoost,
    Math.floor(age / policy.agingIntervalMs) * policy.agingStep
  );
  return {
    score: classScore + job.priority + aging,
    deadline: job.deadlineMs ?? Number.POSITIVE_INFINITY,
    screenSpaceError: job.screenSpaceError ?? Number.NEGATIVE_INFINITY
  };
}

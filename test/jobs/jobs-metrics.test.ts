import { describe, expect, test } from 'vitest';
import { JobScheduler, defineJobType } from '../../src';

describe('job scheduler metrics', () => {
  test('returns a frozen snapshot covering failures, cancellations, bytes, and retries', async () => {
    const scheduler = new JobScheduler({
      budgets: {
        background: {
          maxInFlightJobs: 0,
          maxInputBytes: 0,
          maxDecodeBytes: 0
        }
      }
    });
    const Job = defineJobType({
      id: 'test.metrics-job',
      encode: (input: number) => ({ payload: input, inputBytes: 4, decodeBytes: 8, transfer: [] }),
      decode: Number,
      summarize: () => ({ safe: true })
    });
    scheduler.register(Job);
    await scheduler.schedule(Job, { input: 1, priority: 0, budgetClass: 'background' }).result;

    expect(scheduler.metrics()).toMatchObject({ failures: 1, cancellations: 0, retries: 0 });
    expect(scheduler.metrics().failuresByType).toEqual({ 'test.metrics-job': 1 });
    expect(Object.isFrozen(scheduler.metrics())).toBe(true);
  });

  test('does not expose codec error text in diagnostics', async () => {
    const scheduler = new JobScheduler();
    const SecretJob = defineJobType({
      id: 'test.secret-job',
      encode: (_input: number) => {
        throw new Error('secret-token-123');
      },
      decode: Number,
      summarize: () => ({ safe: true })
    });
    scheduler.register(SecretJob);

    const result = await scheduler.schedule(SecretJob, {
      input: 1,
      priority: 0,
      budgetClass: 'interactive'
    }).result;

    expect(JSON.stringify(result)).not.toContain('secret-token-123');
  });

  test('marks a repeatedly failing job type unavailable and retains a safe reason', async () => {
    const scheduler = new JobScheduler({
      budgets: {
        background: {
          maxInFlightJobs: 0,
          maxInputBytes: 0,
          maxDecodeBytes: 0
        }
      }
    });
    const Job = defineJobType({
      id: 'test.unavailable-job',
      encode: () => ({ payload: null, inputBytes: 0, decodeBytes: 0, transfer: [] }),
      decode: Number,
      summarize: () => ({ safe: true })
    });
    scheduler.register(Job);
    for (let attempt = 0; attempt < 3; attempt++) {
      await scheduler.schedule(Job, {
        input: undefined,
        priority: 0,
        budgetClass: 'background'
      }).result;
    }

    const metrics = scheduler.metrics();
    const health = metrics.healthByType['test.unavailable-job'];

    expect(health).toEqual({
      status: 'unavailable',
      consecutiveFailures: 3,
      lastReason: 'job-budget-exceeded'
    });
    expect(Object.isFrozen(health)).toBe(true);
    expect(() => Object.assign(health!, { status: 'healthy' })).toThrow();
    expect(scheduler.metrics().healthByType['test.unavailable-job']).toEqual({
      status: 'unavailable',
      consecutiveFailures: 3,
      lastReason: 'job-budget-exceeded'
    });
  });
});

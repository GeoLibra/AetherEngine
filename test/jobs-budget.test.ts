import { describe, expect, test } from 'vitest';
import { JobScheduler, defineJobType } from '../src';

const BytesJob = defineJobType({
  id: 'test.jobs-budget-bytes',
  encode: (input: ArrayBuffer) => ({
    payload: input, inputBytes: input.byteLength, decodeBytes: input.byteLength * 2,
    transfer: [input]
  }),
  decode: (value: unknown) => value as number,
  summarize: (input: ArrayBuffer) => ({ byteLength: input.byteLength })
});

describe('JobScheduler budgets', () => {
  test('requires registration and rejects duplicate job type ids', () => {
    const scheduler = new JobScheduler();
    expect(() => scheduler.schedule(BytesJob, request(new ArrayBuffer(1)))).toThrow('not registered');
    scheduler.register(BytesJob);
    expect(() => scheduler.register(BytesJob)).toThrow('already registered');
  });

  test('resolves budget excess as a typed failed result', async () => {
    const scheduler = new JobScheduler({
      budgets: {
        interactive: { maxInFlightJobs: 1, maxInputBytes: 8, maxDecodeBytes: 16 }
      }
    });
    scheduler.register(BytesJob);

    const handle = scheduler.schedule(BytesJob, request(new ArrayBuffer(16)));

    await expect(handle.result).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'job-budget-exceeded', jobType: 'test.jobs-budget-bytes' }
    });
    expect(scheduler.queuedCount).toBe(0);
  });
});

function request(input: ArrayBuffer) {
  return { input, priority: 0, budgetClass: 'interactive' as const };
}

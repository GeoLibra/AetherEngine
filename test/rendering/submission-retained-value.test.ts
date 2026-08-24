import { describe, expect, test } from 'vitest';
import { SubmissionRetainedValue } from '../../src/rendering';
import type { RHISubmission, SubmissionResult } from '../../src/rhi/contracts';

describe('SubmissionRetainedValue', () => {
  test('stops acquisition immediately and destroys after local and submission leases finish', async () => {
    const destroyed: string[] = [];
    const retained = new SubmissionRetainedValue('pipeline', (value) => destroyed.push(value));
    const submission = deferredSubmission(1);
    const lease = retained.acquire()!;

    lease.retain(submission.value);
    lease.retain(submission.value);
    expect(retained.retire()).toBe(true);
    expect(retained.acquire()).toBeUndefined();
    lease.release();
    lease.release();
    expect(destroyed).toEqual([]);
    expect(retained.snapshot()).toEqual({
      state: 'retired',
      localLeases: 0,
      pendingSubmissions: 1
    });

    submission.resolve({ status: 'completed' });
    await submission.value.done;
    await Promise.resolve();

    expect(destroyed).toEqual(['pipeline']);
    expect(retained.snapshot()).toEqual({
      state: 'destroyed',
      localLeases: 0,
      pendingSubmissions: 0
    });
  });

  test.each(['failed', 'device-lost'] as const)(
    'treats a %s submission as terminal',
    async (status) => {
      const destroyed: string[] = [];
      const retained = new SubmissionRetainedValue(status, (value) => destroyed.push(value));
      const submission = deferredSubmission(status === 'failed' ? 2 : 3);
      const lease = retained.acquire()!;
      lease.retain(submission.value);
      retained.retire();
      lease.release();

      submission.resolve({ status });
      await submission.value.done;
      await Promise.resolve();
      expect(destroyed).toEqual([status]);
    }
  );

  test('contains destroy errors and treats rejected completion as terminal', async () => {
    const retained = new SubmissionRetainedValue('binding', () => {
      throw new Error('dispose failed');
    });
    const submission = deferredSubmission(4);
    const lease = retained.acquire()!;
    lease.retain(submission.value);
    retained.retire();
    lease.release();
    submission.reject(new Error('backend completion rejected'));
    await submission.value.done.catch(() => undefined);
    await Promise.resolve();

    expect(retained.snapshot().state).toBe('destroyed');
    expect(retained.destroyErrors()).toHaveLength(1);
  });

  test('rejects malformed submissions with a contextual boundary error', () => {
    const retained = new SubmissionRetainedValue('binding', () => undefined);
    const lease = retained.acquire()!;

    expect(() => lease.retain(undefined as unknown as RHISubmission)).toThrow(
      'Submission-retained value lease requires a valid RHISubmission.'
    );
  });

  test('rejects retaining after the local lease has been released', () => {
    const retained = new SubmissionRetainedValue('binding', () => undefined);
    const lease = retained.acquire()!;
    const submission = deferredSubmission(5);
    lease.release();

    expect(() => lease.retain(submission.value)).toThrow(
      'Submission-retained value lease has already been released.'
    );
  });
});

function deferredSubmission(id: number) {
  let status: RHISubmission['status'] = 'pending';
  let resolvePromise!: (result: SubmissionResult) => void;
  let rejectPromise!: (error: unknown) => void;
  const done = new Promise<SubmissionResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const value: RHISubmission = {
    id,
    get status() {
      return status;
    },
    done
  };
  return {
    value,
    resolve(result: SubmissionResult) {
      status = result.status;
      resolvePromise(result);
    },
    reject(error: unknown) {
      status = 'failed';
      rejectPromise(error);
    }
  };
}

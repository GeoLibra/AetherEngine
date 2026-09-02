import { describe, expect, test } from 'vitest';
import {
  JobScheduler,
  defineJobType,
  type JobEnvelope,
  type WorkerExecutor,
  type WorkerFactory,
  type WorkerOutcome
} from '../../src';

class CrashableExecutor implements WorkerExecutor {
  readonly id: string;
  private complete!: (outcome: WorkerOutcome) => void;
  constructor(index: number) {
    this.id = `worker-${index}`;
  }
  execute(_envelope: JobEnvelope, _transfer: readonly ArrayBuffer[], _signal: AbortSignal) {
    return new Promise<WorkerOutcome>((resolve) => {
      this.complete = resolve;
    });
  }
  crash(reason = 'worker exited'): void {
    this.complete({ status: 'crashed', reason });
  }
  succeed(output: unknown): void {
    this.complete({ status: 'completed', output });
  }
  dispose(): void {}
}

class RecordingFactory implements WorkerFactory {
  readonly workers: CrashableExecutor[] = [];
  create(): CrashableExecutor {
    const worker = new CrashableExecutor(this.workers.length);
    this.workers.push(worker);
    return worker;
  }
}

function job(id: string, idempotent: boolean, retryLimit: number) {
  return defineJobType({
    id,
    encode: (input: number) => ({ payload: input, inputBytes: 0, decodeBytes: 0, transfer: [] }),
    decode: (value: unknown) => Number(value),
    summarize: (input: number) => ({ input }),
    idempotent,
    retryLimit
  });
}

describe('worker crash retry', () => {
  test('replaces a crashed worker and retries bounded idempotent work', async () => {
    const factory = new RecordingFactory();
    const scheduler = new JobScheduler({ workerFactory: factory, workerCount: 1 });
    const RetryJob = job('test.retry-idempotent', true, 1);
    scheduler.register(RetryJob);
    const handle = scheduler.schedule(RetryJob, request(1));

    factory.workers[0]!.crash();
    await Promise.resolve();
    factory.workers[1]!.succeed(2);

    await expect(handle.result).resolves.toMatchObject({
      status: 'completed',
      output: 2,
      metrics: { attempts: 2 }
    });
    expect(scheduler.metrics().retries).toBe(1);
  });

  test('fails non-idempotent work with redacted context', async () => {
    const factory = new RecordingFactory();
    const scheduler = new JobScheduler({ workerFactory: factory, workerCount: 1 });
    const UnsafeJob = job('test.retry-unsafe', false, 3);
    scheduler.register(UnsafeJob);
    const handle = scheduler.schedule(UnsafeJob, request(7));
    factory.workers[0]!.crash('secret binary payload');

    await expect(handle.result).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'job-worker-crashed',
        jobType: 'test.retry-unsafe',
        inputSummary: { input: 7 },
        attempt: 1,
        workerId: 'worker-0'
      }
    });
  });
});

function request(input: number) {
  return { input, priority: 0, budgetClass: 'background' as const };
}

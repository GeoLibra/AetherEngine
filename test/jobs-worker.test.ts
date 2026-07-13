import { describe, expect, test } from 'vitest';
import {
  JobScheduler, defineJobType,
  type JobEnvelope, type WorkerExecutor, type WorkerFactory, type WorkerOutcome
} from '../src';

class ControlledExecutor implements WorkerExecutor {
  readonly id = 'test-worker';
  private complete!: (outcome: WorkerOutcome) => void;
  signal: AbortSignal | undefined;

  execute(envelope: JobEnvelope, transfer: readonly ArrayBuffer[], signal: AbortSignal) {
    structuredClone(envelope, { transfer: [...transfer] });
    this.signal = signal;
    return new Promise<WorkerOutcome>((resolve) => { this.complete = resolve; });
  }
  succeed(output: unknown): void { this.complete({ status: 'completed', output }); }
  dispose(): void {}
}

const TransferJob = defineJobType({
  id: 'test.transfer-job',
  encode: (input: ArrayBuffer) => ({
    payload: input, inputBytes: input.byteLength, decodeBytes: 8, transfer: [input]
  }),
  decode: (value: unknown) => value as { vertices: number },
  summarize: (input: ArrayBuffer) => ({ byteLength: input.byteLength })
});

describe('job worker execution', () => {
  test('dispatches through an injected executor and transfers ArrayBuffer ownership', async () => {
    const executor = new ControlledExecutor();
    const scheduler = schedulerWith(executor);
    scheduler.register(TransferJob);
    const bytes = new ArrayBuffer(16);

    const handle = scheduler.schedule(TransferJob, request(bytes));

    expect(bytes.byteLength).toBe(0);
    executor.succeed({ vertices: 3 });
    await expect(handle.result).resolves.toMatchObject({
      status: 'completed', output: { vertices: 3 },
      metrics: { attempts: 1, inputBytes: 16, transferBytes: 16, copyBytes: 0 }
    });
  });

  test('requires scheduler capability and registration opt-in for shared memory', async () => {
    const SharedJob = defineJobType({
      id: 'test.shared-job',
      encode: (input: SharedArrayBuffer) => ({
        payload: input, inputBytes: input.byteLength, decodeBytes: 0, transfer: [],
        usesSharedMemory: true
      }),
      decode: () => true,
      summarize: () => ({ shared: true })
    });
    const scheduler = new JobScheduler({ capabilities: { sharedMemory: true } });
    scheduler.register(SharedJob);

    await expect(scheduler.schedule(SharedJob, request(new SharedArrayBuffer(4))).result)
      .resolves.toMatchObject({ status: 'failed', diagnostic: { code: 'job-shared-memory-unsupported' } });

    const SharedOptInJob = defineJobType({
      id: 'test.shared-opt-in-job',
      encode: (input: SharedArrayBuffer) => ({
        payload: input, inputBytes: input.byteLength, decodeBytes: 0, transfer: [],
        usesSharedMemory: true
      }),
      decode: () => true,
      summarize: () => ({ shared: true }),
      allowSharedMemory: true
    });
    scheduler.register(SharedOptInJob);

    const accepted = scheduler.schedule(SharedOptInJob, request(new SharedArrayBuffer(4)));
    expect(scheduler.queuedCount).toBe(1);
    accepted.cancel();
    await expect(accepted.result).resolves.toMatchObject({ status: 'cancelled' });
  });
});

function schedulerWith(executor: ControlledExecutor): JobScheduler {
  const factory: WorkerFactory = { create: () => executor };
  return new JobScheduler({ workerFactory: factory, workerCount: 1 });
}

function request<T>(input: T) {
  return { input, priority: 0, budgetClass: 'interactive' as const };
}

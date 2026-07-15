import { describe, expect, test } from 'vitest';
import { JobScheduler, defineJobType, type JobEnvelope, type WorkerExecutor, type WorkerOutcome } from '../../src';

class PendingExecutor implements WorkerExecutor {
  readonly id = 'pending-worker';
  private complete!: (outcome: WorkerOutcome) => void;
  signal: AbortSignal | undefined;
  execute(_envelope: JobEnvelope, _transfer: readonly ArrayBuffer[], signal: AbortSignal) {
    this.signal = signal;
    return new Promise<WorkerOutcome>((resolve) => { this.complete = resolve; });
  }
  succeed(): void { this.complete({ status: 'completed', output: 1 }); }
  dispose(): void {}
}

const Job = defineJobType({
  id: 'test.cancellable-job',
  encode: (input: number) => ({ payload: input, inputBytes: 0, decodeBytes: 0, transfer: [] }),
  decode: (value: unknown) => Number(value), summarize: (input: number) => ({ input })
});

describe('job cancellation', () => {
  test('removes the caller AbortSignal listener after completion', async () => {
    const executor = new PendingExecutor();
    const scheduler = new JobScheduler({ workerFactory: { create: () => executor }, workerCount: 1 });
    const signal = new TrackingAbortSignal();
    scheduler.register(Job);

    const handle = scheduler.schedule(Job, { ...request(1), signal: signal.asAbortSignal() });
    expect(signal.listenerCount).toBe(1);
    executor.succeed();
    await handle.result;

    expect(signal.listenerCount).toBe(0);
  });

  test('cancels queued work before dispatch', async () => {
    const scheduler = new JobScheduler();
    scheduler.register(Job);
    const handle = scheduler.schedule(Job, request(1));
    handle.cancel('scene unloaded');
    await expect(handle.result).resolves.toEqual({ status: 'cancelled', reason: 'scene unloaded' });
  });

  test('first terminal state wins active cancellation and completion races', async () => {
    const executor = new PendingExecutor();
    const scheduler = new JobScheduler({ workerFactory: { create: () => executor }, workerCount: 1 });
    scheduler.register(Job);
    const handle = scheduler.schedule(Job, request(1));
    handle.cancel('cancel first');
    executor.succeed();

    await expect(handle.result).resolves.toEqual({ status: 'cancelled', reason: 'cancel first' });
    expect(executor.signal?.aborted).toBe(true);
  });

  test('cancel after completion does not replace the completed result', async () => {
    const executor = new PendingExecutor();
    const scheduler = new JobScheduler({ workerFactory: { create: () => executor }, workerCount: 1 });
    scheduler.register(Job);
    const handle = scheduler.schedule(Job, request(1));
    executor.succeed();
    const result = await handle.result;
    handle.cancel('too late');
    expect(result).toMatchObject({ status: 'completed', output: 1 });
  });
});

function request(input: number) {
  return { input, priority: 0, budgetClass: 'interactive' as const };
}

class TrackingAbortSignal {
  readonly aborted = false;
  readonly reason: unknown = undefined;
  private listener: EventListenerOrEventListenerObject | undefined;

  get listenerCount(): number { return this.listener === undefined ? 0 : 1; }

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listener = listener;
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    if (this.listener === listener) this.listener = undefined;
  }

  asAbortSignal(): AbortSignal {
    return this as unknown as AbortSignal;
  }
}

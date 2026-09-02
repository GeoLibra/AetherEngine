import type { WorkerExecutor, WorkerFactory } from './types';

interface WorkerSlot {
  executor: WorkerExecutor;
  busy: boolean;
}

export class WorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly factory: WorkerFactory | undefined;
  private readonly retiredDisposals: Promise<void>[] = [];
  private readonly retiredDisposalErrors: unknown[] = [];

  constructor(factory: WorkerFactory | undefined, count: number) {
    this.factory = factory;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('Job workerCount must be a non-negative integer.');
    }
    if (count > 0 && !factory) {
      throw new Error('Job workerFactory is required when workerCount is positive.');
    }
    this.slots = Array.from({ length: count }, (_value, index) => ({
      executor: factory!.create(index),
      busy: false
    }));
  }

  get size(): number {
    return this.slots.length;
  }

  get busyCount(): number {
    return this.slots.filter((slot) => slot.busy).length;
  }

  acquire(): WorkerExecutor | undefined {
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) return undefined;
    slot.busy = true;
    return slot.executor;
  }

  release(executor: WorkerExecutor): void {
    const slot = this.slots.find((candidate) => candidate.executor === executor);
    if (slot) slot.busy = false;
  }

  replace(executor: WorkerExecutor): void {
    const index = this.slots.findIndex((candidate) => candidate.executor === executor);
    if (index < 0 || !this.factory) return;
    // Retired workers may dispose asynchronously. Capture failures immediately so they
    // cannot surface as unhandled rejections before the scheduler lifecycle ends.
    this.retiredDisposals.push(
      Promise.resolve()
        .then(() => executor.dispose())
        .catch((error: unknown) => {
          this.retiredDisposalErrors.push(error);
        })
    );
    this.slots[index] = { executor: this.factory.create(index), busy: false };
  }

  async destroy(): Promise<void> {
    await Promise.all([
      ...this.retiredDisposals,
      ...this.slots.map(({ executor }) => Promise.resolve().then(() => executor.dispose()))
    ]);
    if (this.retiredDisposalErrors.length > 0) {
      throw new AggregateError(
        this.retiredDisposalErrors,
        'One or more retired job workers failed to dispose.'
      );
    }
  }
}

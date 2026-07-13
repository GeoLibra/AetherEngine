import type { WorkerExecutor, WorkerFactory } from './types';

interface WorkerSlot { executor: WorkerExecutor; busy: boolean; }

export class WorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly factory: WorkerFactory | undefined;

  constructor(factory: WorkerFactory | undefined, count: number) {
    this.factory = factory;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('Job workerCount must be a non-negative integer.');
    }
    if (count > 0 && !factory) {
      throw new Error('Job workerFactory is required when workerCount is positive.');
    }
    this.slots = Array.from({ length: count }, (_value, index) => ({
      executor: factory!.create(index), busy: false
    }));
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
    void Promise.resolve(executor.dispose());
    this.slots[index] = { executor: this.factory.create(index), busy: false };
  }

  async destroy(): Promise<void> {
    await Promise.all(this.slots.map(({ executor }) => executor.dispose()));
  }
}

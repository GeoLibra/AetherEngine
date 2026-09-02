import { describe, expect, test } from 'vitest';
import {
  App,
  JobSchedulerService,
  createJobsPlugin,
  type JobEnvelope,
  type WorkerExecutor,
  type WorkerOutcome
} from '../../src';

class DisposableWorker implements WorkerExecutor {
  readonly id: string;
  disposed = false;
  constructor(index: number) {
    this.id = `plugin-worker-${index}`;
  }
  execute(_envelope: JobEnvelope, _transfer: readonly ArrayBuffer[], _signal: AbortSignal) {
    return Promise.resolve<WorkerOutcome>({ status: 'completed', output: null });
  }
  dispose(): void {
    this.disposed = true;
  }
}

describe('Jobs plugin', () => {
  test('owns scheduler service and disposes its workers with App', async () => {
    const workers: DisposableWorker[] = [];
    const app = new App().addPlugin(
      createJobsPlugin({
        workerCount: 2,
        workerFactory: {
          create(index) {
            const worker = new DisposableWorker(index);
            workers.push(worker);
            return worker;
          }
        }
      })
    );

    await app.startup();
    const scheduler = app.getService(JobSchedulerService);
    expect(scheduler.state).toBe('running');

    await app.destroy();

    expect(scheduler.state).toBe('destroyed');
    expect(workers.map((worker) => worker.disposed)).toEqual([true, true]);
  });
});

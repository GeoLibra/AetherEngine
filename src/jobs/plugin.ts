import { createServiceToken, definePlugin, serviceFactory } from '../app/utils';
import type { ServiceToken } from '../app/types';
import { JobScheduler } from './scheduler';
import type { JobSchedulerOptions } from './types';

export const JobSchedulerService: ServiceToken<JobScheduler> =
  createServiceToken<JobScheduler>('jobs.scheduler');

export function createJobsPlugin(options: JobSchedulerOptions = {}) {
  return definePlugin({
    id: 'aether.jobs',
    build(app) {
      app.provideService(
        JobSchedulerService,
        serviceFactory(() => new JobScheduler(options), {
          scope: 'main',
          dispose: (scheduler) => scheduler.destroy()
        })
      );
    }
  });
}

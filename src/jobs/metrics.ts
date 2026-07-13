import type { JobSchedulerMetrics } from './types';

export class JobMetricsCollector {
  completed = 0;
  failures = 0;
  cancellations = 0;
  retries = 0;
  queueLatencyMs = 0;
  executionTimeMs = 0;
  commitLatencyMs = 0;
  inFlightBytes = 0;
  transferBytes = 0;
  copyBytes = 0;
  committedOutputBytes = 0;
  private readonly failuresByType = new Map<string, number>();

  recordFailure(type: string): void {
    this.failures++;
    this.failuresByType.set(type, (this.failuresByType.get(type) ?? 0) + 1);
  }

  snapshot(queued: number, active: number, busyWorkers: number, workers: number): JobSchedulerMetrics {
    return Object.freeze({
      queuedJobs: queued,
      activeJobs: active,
      completed: this.completed,
      failures: this.failures,
      cancellations: this.cancellations,
      retries: this.retries,
      queueLatencyMs: this.queueLatencyMs,
      executionTimeMs: this.executionTimeMs,
      commitLatencyMs: this.commitLatencyMs,
      workerUtilization: workers === 0 ? 0 : busyWorkers / workers,
      inFlightBytes: this.inFlightBytes,
      transferBytes: this.transferBytes,
      copyBytes: this.copyBytes,
      committedOutputBytes: this.committedOutputBytes,
      failuresByType: Object.freeze(Object.fromEntries(this.failuresByType))
    });
  }
}

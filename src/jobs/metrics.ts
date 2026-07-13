import type { JobSchedulerMetrics, JobTypeHealth } from './types';

const UNAVAILABLE_FAILURE_THRESHOLD = 3;

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
  private readonly healthByType = new Map<string, JobTypeHealth>();

  recordFailure(type: string, reason: string): void {
    this.failures++;
    this.failuresByType.set(type, (this.failuresByType.get(type) ?? 0) + 1);
    const count = (this.healthByType.get(type)?.consecutiveFailures ?? 0) + 1;
    this.healthByType.set(type, Object.freeze({
      status: count >= UNAVAILABLE_FAILURE_THRESHOLD ? 'unavailable' : 'degraded',
      consecutiveFailures: count,
      lastReason: reason
    }));
  }

  recordSuccess(type: string): void {
    this.healthByType.set(type, Object.freeze({
      status: 'healthy',
      consecutiveFailures: 0
    }));
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
      failuresByType: Object.freeze(Object.fromEntries(this.failuresByType)),
      healthByType: Object.freeze(Object.fromEntries(this.healthByType))
    });
  }
}

export type RHISubmissionStatus = 'pending' | 'completed' | 'failed' | 'device-lost';

export interface SubmissionResult {
  readonly status: Exclude<RHISubmissionStatus, 'pending'>;
  readonly error?: unknown;
}

export interface RHISubmission {
  readonly id: number;
  readonly status: RHISubmissionStatus;
  readonly done: Promise<SubmissionResult>;
}

export interface RHIQueueMetrics {
  readonly submitted: number;
  readonly pending: number;
  readonly completed: number;
  readonly failed: number;
  readonly deviceLost: number;
  readonly leasedResources: number;
}

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
  /** Number of successful CPU-to-GPU upload calls accepted by this queue. */
  readonly uploadCalls: number;
  /** Total byte length accepted by successful CPU-to-GPU upload calls. */
  readonly uploadBytes: number;
  readonly submitted: number;
  readonly pending: number;
  readonly completed: number;
  readonly failed: number;
  readonly deviceLost: number;
  readonly leasedResources: number;
}

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

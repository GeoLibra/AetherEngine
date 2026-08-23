import type {
  RHISubmission,
  RHISubmissionStatus,
  SubmissionResult
} from '../../contracts/submission';

export class WebGL2Submission implements RHISubmission {
  private currentStatus: RHISubmissionStatus = 'pending';
  private resolveDone!: (result: SubmissionResult) => void;
  readonly done: Promise<SubmissionResult>;

  constructor(readonly id: number) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get status(): RHISubmissionStatus {
    return this.currentStatus;
  }

  settle(status: Exclude<RHISubmissionStatus, 'pending'>, error?: unknown): void {
    if (this.currentStatus !== 'pending') return;
    this.currentStatus = status;
    this.resolveDone(Object.freeze(error === undefined ? { status } : { status, error }));
  }
}

import type { AppExit, Runner, RunnerContext } from '../app/runner';
import type { NativeFramePort } from './types';

export interface NativeRunnerBoundary {
  dispatchFrame(run: () => void): Promise<void>;
  beforeFrame(timestampSeconds: number): void;
  afterFrame(timestampSeconds: number): void;
}

export class NativeRunner implements Runner {
  private pendingFrame: number | undefined;
  private stopReason: string | undefined;
  private resolve: ((exit: AppExit) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private frameCount = 0;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private running = false;
  private executingFrame = false;

  constructor(
    private readonly frames: NativeFramePort,
    private readonly boundary: NativeRunnerBoundary
  ) {}

  run(context: RunnerContext): Promise<AppExit> {
    if (this.running) return Promise.reject(new Error('NativeRunner is already running.'));
    this.running = true;
    return new Promise<AppExit>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.stopReason || context.stopRequested) {
        this.finish(this.stopReason ?? 'requested');
      } else {
        this.schedule(context);
      }
    });
  }

  requestStop(reason: string): void {
    this.stopReason ??= reason;
    if (this.pendingFrame !== undefined) {
      this.frames.cancel(this.pendingFrame);
      this.pendingFrame = undefined;
    }
    if (this.running && !this.executingFrame) this.finish(this.stopReason);
  }

  private schedule(context: RunnerContext): void {
    // Exactly one platform callback is pending; native cadence never falls back to a busy loop.
    this.pendingFrame = this.frames.request((timestampSeconds) => {
      this.pendingFrame = undefined;
      void this.boundary
        .dispatchFrame(() => this.acceptFrame(context, timestampSeconds))
        .catch((error: unknown) => this.fail(error));
    });
  }

  private acceptFrame(context: RunnerContext, timestampSeconds: number): void {
    if (this.stopReason || context.stopRequested) {
      this.finish(this.stopReason ?? 'requested');
      return;
    }
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < this.lastTimestamp) {
      this.fail(new Error('Native frame timestamps must be finite and monotonic.'));
      return;
    }
    this.lastTimestamp = timestampSeconds;
    this.executeFrame(context, timestampSeconds);
  }

  private executeFrame(context: RunnerContext, timestampSeconds: number): void {
    this.executingFrame = true;
    let prepared = false;
    let failed = false;
    let failure: unknown;
    try {
      this.boundary.beforeFrame(timestampSeconds);
      prepared = true;
      context.frame(timestampSeconds);
      this.frameCount += 1;
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (prepared) {
      try {
        this.boundary.afterFrame(timestampSeconds);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    this.executingFrame = false;
    if (failed) {
      this.fail(failure);
    } else if (this.stopReason || context.stopRequested) {
      this.finish(this.stopReason ?? 'requested');
    } else if (this.running) {
      this.schedule(context);
    }
  }

  private finish(reason: string): void {
    if (!this.running) return;
    this.running = false;
    const resolve = this.resolve;
    this.resolve = undefined;
    this.reject = undefined;
    resolve?.(Object.freeze({ reason, frames: this.frameCount }));
  }

  private fail(error: unknown): void {
    if (!this.running) return;
    this.running = false;
    const reject = this.reject;
    this.resolve = undefined;
    this.reject = undefined;
    reject?.(error);
  }
}

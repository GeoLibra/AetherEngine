import type {
  AnimationFrameHost,
  AppExit,
  FrameOutcome,
  Runner,
  RunnerContext
} from '@aether/engine';

const DEFAULT_HOST: AnimationFrameHost = {
  request: (cb) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : (setTimeout(() => cb(Date.now()), 16) as unknown as number),
  cancel: (id) =>
    typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)
};

/** Persistent runner advanced explicitly by deterministic browser acceptance controls. */
export class DemandDrivenRunner implements Runner {
  private context: RunnerContext | undefined;
  private resolveRun: ((exit: AppExit) => void) | undefined;
  private rejectRun: ((error: unknown) => void) | undefined;
  private stopReason: string | undefined;
  private frames = 0;
  private continuous = false;
  private rafId: number | undefined;
  private baseTimestamp: number | undefined;
  private readonly host: AnimationFrameHost;

  constructor(host: AnimationFrameHost = DEFAULT_HOST) {
    this.host = host;
  }

  run(context: RunnerContext): Promise<AppExit> {
    if (this.context !== undefined)
      return Promise.reject(new Error('DemandDrivenRunner is active.'));
    this.context = context;
    return new Promise<AppExit>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
      if (this.stopReason !== undefined || context.stopRequested) this.finish();
    });
  }

  frame(): FrameOutcome {
    const context = this.context;
    if (context === undefined) throw new Error('DemandDrivenRunner has not started.');
    if (this.stopReason !== undefined || context.stopRequested)
      throw new Error('DemandDrivenRunner cannot advance after stop.');
    try {
      const outcome = context.frame(this.frames / 60);
      this.frames += 1;
      return outcome;
    } catch (error) {
      this.rejectRun?.(error);
      this.clear();
      throw error;
    }
  }

  setContinuous(enabled: boolean): void {
    if (this.continuous === enabled) return;
    this.continuous = enabled;
    if (enabled) {
      this.baseTimestamp = undefined;
      this.scheduleNextContinuousFrame();
    } else if (this.rafId !== undefined) {
      this.host.cancel(this.rafId);
      this.rafId = undefined;
    }
  }

  private scheduleNextContinuousFrame(): void {
    if (!this.continuous || this.context === undefined || this.stopReason !== undefined) return;
    this.rafId = this.host.request((nowMs) => {
      this.rafId = undefined;
      if (!this.continuous || this.context === undefined || this.stopReason !== undefined) return;
      if (this.baseTimestamp === undefined) {
        this.baseTimestamp = nowMs / 1000 - this.frames / 60;
      }
      const timestampSeconds = nowMs / 1000 - this.baseTimestamp;
      try {
        this.context.frame(timestampSeconds);
        this.frames += 1;
      } catch (error) {
        this.rejectRun?.(error);
        this.clear();
        return;
      }
      this.scheduleNextContinuousFrame();
    });
  }

  requestStop(reason: string): void {
    this.stopReason ??= reason;
    if (this.rafId !== undefined) {
      this.host.cancel(this.rafId);
      this.rafId = undefined;
    }
    if (this.context !== undefined) this.finish();
  }

  private finish(): void {
    if (this.rafId !== undefined) {
      this.host.cancel(this.rafId);
      this.rafId = undefined;
    }
    this.resolveRun?.(
      Object.freeze({ reason: this.stopReason ?? 'requested', frames: this.frames })
    );
    this.clear();
  }

  private clear(): void {
    if (this.rafId !== undefined) {
      this.host.cancel(this.rafId);
      this.rafId = undefined;
    }
    this.continuous = false;
    this.context = undefined;
    this.resolveRun = undefined;
    this.rejectRun = undefined;
  }
}

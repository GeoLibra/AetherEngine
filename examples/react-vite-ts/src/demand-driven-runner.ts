import type { AppExit, FrameOutcome, Runner, RunnerContext } from '@aether/engine';

/** Persistent runner advanced explicitly by deterministic browser acceptance controls. */
export class DemandDrivenRunner implements Runner {
  private context: RunnerContext | undefined;
  private resolveRun: ((exit: AppExit) => void) | undefined;
  private rejectRun: ((error: unknown) => void) | undefined;
  private stopReason: string | undefined;
  private frames = 0;

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

  requestStop(reason: string): void {
    this.stopReason ??= reason;
    if (this.context !== undefined) this.finish();
  }

  private finish(): void {
    this.resolveRun?.(
      Object.freeze({ reason: this.stopReason ?? 'requested', frames: this.frames })
    );
    this.clear();
  }

  private clear(): void {
    this.context = undefined;
    this.resolveRun = undefined;
    this.rejectRun = undefined;
  }
}

import type { AppExit, Runner, RunnerContext } from '../app/runner';

/** Inserts Host-owned state publication immediately before each App frame. */
export class HostBoundaryRunner implements Runner {
  constructor(
    private readonly runner: Runner,
    private readonly beforeFrame: (timestampSeconds: number) => void
  ) {}

  run(context: RunnerContext): Promise<AppExit> {
    const beforeFrame = this.beforeFrame;
    return this.runner.run({
      get stopRequested() {
        return context.stopRequested;
      },
      frame(timestampSeconds) {
        beforeFrame(timestampSeconds);
        return context.frame(timestampSeconds);
      }
    });
  }

  requestStop(reason: string): void {
    this.runner.requestStop(reason);
  }
}

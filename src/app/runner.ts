export interface FrameOutcome {
  readonly frame: number;
}

export interface AppExit {
  readonly reason: string;
  readonly frames: number;
}

export interface RunnerContext {
  readonly stopRequested: boolean;
  frame(timestampSeconds: number): FrameOutcome;
}

export interface Runner {
  run(context: RunnerContext): Promise<AppExit>;
  requestStop(reason: string): void;
}

export interface HeadlessRunnerOptions {
  readonly frames: number;
  readonly frameDelta?: number;
  readonly startTime?: number;
}

/** Deterministic finite runner for tests, servers, and offline tools. */
export class HeadlessRunner implements Runner {
  private stopReason?: string;
  private readonly frameDelta: number;
  private readonly startTime: number;

  constructor(private readonly options: HeadlessRunnerOptions) {
    if (!Number.isInteger(options.frames) || options.frames < 0) {
      throw new Error('HeadlessRunner frames must be a non-negative integer.');
    }
    this.frameDelta = options.frameDelta ?? 1 / 60;
    this.startTime = options.startTime ?? 0;
    if (!Number.isFinite(this.frameDelta) || this.frameDelta < 0) {
      throw new Error('HeadlessRunner frameDelta must be a non-negative finite number.');
    }
    if (!Number.isFinite(this.startTime)) {
      throw new Error('HeadlessRunner startTime must be finite.');
    }
  }

  async run(context: RunnerContext): Promise<AppExit> {
    let frames = 0;
    while (frames < this.options.frames && !this.stopReason && !context.stopRequested) {
      context.frame(this.startTime + frames * this.frameDelta);
      frames++;
    }
    return Object.freeze({
      reason: this.stopReason ?? (context.stopRequested ? 'requested' : 'completed'),
      frames
    });
  }

  requestStop(reason: string): void {
    this.stopReason ??= reason;
  }
}

export interface AnimationFrameHost {
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}

/** Animation-frame cadence adapter with no dependency on browser globals. */
export class BrowserRunner implements Runner {
  private pendingFrame: number | undefined;
  private stopReason?: string;
  private resolve: ((exit: AppExit) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private frameCount = 0;
  private running = false;
  private executingFrame = false;

  constructor(private readonly host: AnimationFrameHost) {}

  run(context: RunnerContext): Promise<AppExit> {
    if (this.running) {
      return Promise.reject(new Error('BrowserRunner is already running.'));
    }
    this.running = true;

    return new Promise<AppExit>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.stopReason || context.stopRequested) {
        this.finish(this.stopReason ?? 'requested');
        return;
      }
      this.schedule(context);
    });
  }

  requestStop(reason: string): void {
    this.stopReason ??= reason;
    if (this.pendingFrame !== undefined) {
      this.host.cancel(this.pendingFrame);
      this.pendingFrame = undefined;
    }
    if (this.running && !this.executingFrame) {
      this.finish(this.stopReason);
    }
  }

  private schedule(context: RunnerContext): void {
    this.pendingFrame = this.host.request((timestampMilliseconds) => {
      this.pendingFrame = undefined;
      if (this.stopReason || context.stopRequested) {
        this.finish(this.stopReason ?? 'requested');
        return;
      }
      this.executingFrame = true;
      try {
        context.frame(timestampMilliseconds / 1000);
        this.frameCount++;
      } catch (error) {
        this.executingFrame = false;
        this.fail(error);
        return;
      }
      this.executingFrame = false;
      if (this.stopReason || context.stopRequested) {
        this.finish(this.stopReason ?? 'requested');
      } else if (this.running) {
        this.schedule(context);
      }
    });
  }

  private finish(reason: string): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    const resolve = this.resolve;
    this.resolve = undefined;
    this.reject = undefined;
    resolve?.(Object.freeze({ reason, frames: this.frameCount }));
  }

  private fail(error: unknown): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    const reject = this.reject;
    this.resolve = undefined;
    this.reject = undefined;
    reject?.(error);
  }
}

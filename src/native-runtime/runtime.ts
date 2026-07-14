import type { NativeRuntimeControllerOptions, JsRuntimePort, NativeThreadPort } from './runtime-types';
import { assertNativeJsThread } from './thread';

export class NativeRuntimeOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Native runtime operation "${operation}" failed.`, { cause });
    this.name = 'NativeRuntimeOperationError';
    this.operation = operation;
  }
}

export class NativeRuntimeController {
  readonly runtime: JsRuntimePort;
  private readonly threads: NativeThreadPort;
  private readonly ownsRuntime: boolean;
  private destroyed = false;

  constructor(options: NativeRuntimeControllerOptions) {
    this.threads = options.threads;
    this.ownsRuntime = options.ownership === 'dedicated';
    this.runtime = options.ownership === 'dedicated' ? options.createRuntime() : options.runtime;
  }

  isOnJsThread(): boolean { return this.threads.currentThread() === this.threads.jsThread; }

  enterJsThread<T>(operation: string, run: () => T): T {
    this.assertActive(operation);
    assertNativeJsThread(this.threads, operation);
    return run();
  }

  runOnJsThread<T>(operation: string, run: () => T | Promise<T>): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new NativeRuntimeOperationError(operation, new Error('Native runtime is destroyed.')));
    }
    if (this.threads.currentThread() === this.threads.jsThread) return this.run(operation, run);
    return new Promise<T>((resolve, reject) => {
      this.threads.dispatchToJs(() => {
        // Destruction wins over queued work so callbacks cannot enter a dead runtime.
        if (this.destroyed) {
          reject(new NativeRuntimeOperationError(operation, new Error('Native runtime is destroyed.')));
          return;
        }
        void this.run(operation, run).then(resolve, reject);
      });
    });
  }

  checkpointMicrotasks(): void {
    this.enterJsThread('runtime.microtask-checkpoint', () => this.runtime.checkpointMicrotasks());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ownsRuntime) this.runtime.destroy();
  }

  private run<T>(operation: string, run: () => T | Promise<T>): Promise<T> {
    return Promise.resolve().then(run).catch((cause: unknown) => {
      throw cause instanceof NativeRuntimeOperationError ? cause : new NativeRuntimeOperationError(operation, cause);
    });
  }

  private assertActive(operation: string): void {
    if (this.destroyed) throw new NativeRuntimeOperationError(operation, new Error('Native runtime is destroyed.'));
  }
}

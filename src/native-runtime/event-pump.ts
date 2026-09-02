import type { NativeRuntimeController } from './runtime';

export class NativeEventPump {
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly runtime: NativeRuntimeController,
    readonly capacity: number
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('Native event pump capacity must be a positive safe integer.');
    }
  }

  get size(): number {
    return this.queue.length;
  }

  enqueue(callback: () => void): boolean {
    if (this.queue.length >= this.capacity) return false;
    this.queue.push(callback);
    return true;
  }

  drain(): number {
    return this.runtime.enterJsThread('native.event-pump.drain', () => {
      // Snapshot the boundary so callbacks enqueued reentrantly wait for the next host tick.
      const boundary = this.queue.splice(0);
      const errors: unknown[] = [];
      for (const callback of boundary) {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new NativeEventPumpError(errors);
      return boundary.length;
    });
  }
}

export class NativeEventPumpError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[]) {
    super(`Native event pump callback failure (${errors.length}).`);
    this.name = 'NativeEventPumpError';
    this.errors = Object.freeze([...errors]);
  }
}

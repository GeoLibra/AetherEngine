import type {
  NativeBackgroundPolicy,
  NativeLifecycleSnapshot,
  NativeMemoryEvictor,
  NativeMemoryPressureEvent,
  NativeMemoryPressureResult
} from './types';

export class NativeLifecycleTerminationError extends Error {
  readonly errors: readonly unknown[];
  constructor(errors: readonly unknown[]) {
    super(`Native lifecycle termination cleanup failed (${errors.length}).`);
    this.name = 'NativeLifecycleTerminationError';
    this.errors = Object.freeze([...errors]);
  }
}

export class NativeLifecycleCoordinator {
  private readonly listeners = new Set<(snapshot: NativeLifecycleSnapshot) => void>();
  private readonly evictors: NativeMemoryEvictor[] = [];
  private readonly cleanups: Array<() => void> = [];
  private readonly policy: NativeBackgroundPolicy;
  private terminated = false;

  constructor(policy: NativeBackgroundPolicy) {
    this.policy = Object.freeze({ ...policy });
  }

  subscribe(listener: (snapshot: NativeLifecycleSnapshot) => void): () => boolean {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerEvictor(evictor: NativeMemoryEvictor): void {
    this.assertActive();
    if (!/^[a-z][a-z0-9.-]*$/i.test(evictor.name))
      throw new Error('Native memory evictor name is invalid.');
    if (!Number.isFinite(evictor.priority))
      throw new Error('Native memory evictor priority must be finite.');
    if (this.evictors.some(({ name }) => name === evictor.name))
      throw new Error('Duplicate native memory evictor.');
    this.evictors.push(evictor);
  }

  registerCleanup(cleanup: () => void): void {
    this.assertActive();
    this.cleanups.push(cleanup);
  }

  foreground(): void {
    this.emit({ kind: 'foreground' });
  }
  background(): void {
    this.emit({ kind: 'background', policy: this.policy });
  }
  audioInterrupted(interrupted: boolean): void {
    this.emit({ kind: 'audio-interruption', interrupted });
  }
  orientation(orientation: string): void {
    this.emit({ kind: 'orientation', orientation });
  }
  resize(size: readonly [number, number]): void {
    this.emit({ kind: 'resize', size: Object.freeze([...size]) as readonly [number, number] });
  }
  surfaceLost(generation: number): void {
    this.emit({ kind: 'surface-lost', generation });
  }
  surfaceRecreated(generation: number): void {
    this.emit({ kind: 'surface-recreated', generation });
  }

  memoryPressure(event: NativeMemoryPressureEvent): NativeMemoryPressureResult {
    this.assertActive();
    validatePressure(event);
    let evictedBytes = 0;
    let callbacks = 0;
    const failedEvictors: string[] = [];
    const ordered = [...this.evictors].sort(
      (a, b) => a.priority - b.priority || a.name.localeCompare(b.name)
    );
    for (const evictor of ordered) {
      if (evictedBytes >= event.targetBytes || callbacks >= event.maxCallbacks) break;
      callbacks += 1;
      const remaining = event.targetBytes - evictedBytes;
      try {
        const evicted = evictor.evict(remaining);
        if (Number.isFinite(evicted) && evicted > 0) evictedBytes += Math.min(remaining, evicted);
      } catch {
        // A failed pool must not prevent lower-priority pools from honoring pressure.
        failedEvictors.push(evictor.name);
      }
    }
    const result = Object.freeze({
      requestedBytes: event.targetBytes,
      evictedBytes,
      sufficient: evictedBytes >= event.targetBytes,
      callbacks,
      failedEvictors: Object.freeze(failedEvictors)
    });
    this.emit({
      kind: 'memory-pressure',
      pressure: Object.freeze({ ...event }),
      pressureResult: result
    });
    return result;
  }

  terminate(): boolean {
    if (this.terminated) return false;
    this.terminated = true;
    this.listeners.clear();
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups.length = 0;
    this.evictors.length = 0;
    if (errors.length > 0) throw new NativeLifecycleTerminationError(errors);
    return true;
  }

  private emit(snapshot: NativeLifecycleSnapshot): void {
    this.assertActive();
    const frozen = Object.freeze({ ...snapshot });
    for (const listener of [...this.listeners]) listener(frozen);
  }

  private assertActive(): void {
    if (this.terminated) throw new Error('Native lifecycle is terminated.');
  }
}

function validatePressure(event: NativeMemoryPressureEvent): void {
  if (!Number.isSafeInteger(event.targetBytes) || event.targetBytes < 0) {
    throw new Error('Native memory pressure target must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(event.maxCallbacks) || event.maxCallbacks < 0) {
    throw new Error('Native memory pressure callback limit must be a non-negative safe integer.');
  }
}

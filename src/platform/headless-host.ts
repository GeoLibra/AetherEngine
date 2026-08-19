import { HeadlessRunner } from '../app/runner';
import type { MonotonicClock } from '../core/clock';
import { HostBoundaryRunner } from './host-runner';
import { MutablePlatformServiceRegistry } from './services';
import type { Host, HostState, RunnerOptions, WindowId, WindowOptions } from './types';
import { PlatformWindow } from './window';

export interface HeadlessHostOptions {
  readonly startTime?: number;
}

export class ManualClock implements MonotonicClock {
  private time: number;

  constructor(startTime = 0) {
    validateFiniteTime(startTime);
    this.time = startTime;
  }

  now(): number {
    return this.time;
  }

  set(time: number): void {
    validateFiniteTime(time);
    if (time < this.time) {
      throw new Error('ManualClock cannot move backwards.');
    }
    this.time = time;
  }
}

export class HeadlessHost implements Host {
  readonly kind = 'headless' as const;
  readonly clock: ManualClock;
  readonly services = new MutablePlatformServiceRegistry();
  private currentState: HostState = 'active';
  private nextWindowId = 1;
  private readonly ownedWindows: PlatformWindow[] = [];

  constructor(options: HeadlessHostOptions = {}) {
    this.clock = new ManualClock(options.startTime ?? 0);
  }

  get state(): HostState {
    return this.currentState;
  }

  async createWindow(options: WindowOptions): Promise<PlatformWindow> {
    if (this.currentState === 'destroyed') {
      throw new Error('Cannot create a window on a destroyed HeadlessHost.');
    }
    const hostWindow = new PlatformWindow(this.nextWindowId++ as WindowId, options);
    this.ownedWindows.push(hostWindow);
    return hostWindow;
  }

  createRunner(options: RunnerOptions): HostBoundaryRunner {
    if (this.currentState === 'destroyed') {
      throw new Error('Cannot create a runner on a destroyed HeadlessHost.');
    }
    if (options.kind !== 'headless') {
      throw new Error('HeadlessHost only supports headless runners.');
    }
    const runner = new HeadlessRunner({
      frames: options.frames,
      frameDelta: options.frameDelta ?? 1 / 60,
      startTime: options.startTime ?? this.clock.now()
    });
    return new HostBoundaryRunner(runner, (timestampSeconds) => {
      this.clock.set(timestampSeconds);
      this.commitWindowFrameBoundary();
    });
  }

  windows(): readonly PlatformWindow[] {
    return Object.freeze([...this.ownedWindows]);
  }

  destroy(): void {
    if (this.currentState === 'destroyed') {
      return;
    }
    this.currentState = 'destroyed';
    for (const hostWindow of this.ownedWindows) {
      hostWindow.close();
    }
  }

  private commitWindowFrameBoundary(): void {
    for (const hostWindow of this.ownedWindows) {
      hostWindow.commitFrameBoundary();
    }
  }
}

function validateFiniteTime(time: number): void {
  if (!Number.isFinite(time)) {
    throw new Error('ManualClock time must be finite.');
  }
}

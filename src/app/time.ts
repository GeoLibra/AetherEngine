import type { FixedOverrunPolicy, TimePolicyOptions } from './types';
import { defineResource } from '../ecs/resource';

const DEFAULT_FIXED_STEP = 1 / 60;
const DEFAULT_MAX_SUBSTEPS = 5;
const DEFAULT_MAX_FRAME_DELTA = 0.25;
const pendingSingleSteps = new WeakSet<TimeControl>();

export class FrameTime {
  frame = 0;
  elapsed = 0;
  rawDelta = 0;
  delta = 0;
  interpolationAlpha = 0;
}

export class FixedTime {
  tick = 0;
  elapsed = 0;
  substep = 0;

  constructor(
    readonly step: number,
    readonly maxSubsteps: number
  ) {}
}

export class TimePolicy {
  readonly fixedStep: number;
  readonly maxSubsteps: number;
  readonly maxFrameDelta: number;
  readonly overrun: FixedOverrunPolicy;

  constructor(options: TimePolicyOptions = {}) {
    this.fixedStep = options.fixedStep ?? DEFAULT_FIXED_STEP;
    this.maxSubsteps = options.maxSubsteps ?? DEFAULT_MAX_SUBSTEPS;
    this.maxFrameDelta = options.maxFrameDelta ?? DEFAULT_MAX_FRAME_DELTA;
    this.overrun = options.overrun ?? 'discard';

    assertPositiveFinite(this.fixedStep, 'fixedStep');
    assertPositiveFinite(this.maxFrameDelta, 'maxFrameDelta');
    if (!Number.isInteger(this.maxSubsteps) || this.maxSubsteps <= 0) {
      throw new Error('Time policy maxSubsteps must be a positive integer.');
    }
    if (this.overrun !== 'discard' && this.overrun !== 'retain') {
      throw new Error('Time policy overrun must be "discard" or "retain".');
    }
  }
}

export class TimeDiagnostics {
  clampedFrames = 0;
  clampedSeconds = 0;
  overrunFrames = 0;
  droppedSeconds = 0;
}

export class TimeControl {
  private scale = 1;
  private simulationPaused = false;

  get timeScale(): number {
    return this.scale;
  }

  get paused(): boolean {
    return this.simulationPaused;
  }

  pause(): void {
    this.simulationPaused = true;
  }

  resume(): void {
    this.simulationPaused = false;
    pendingSingleSteps.delete(this);
  }

  requestSingleStep(): void {
    if (!this.simulationPaused) {
      throw new Error('Single-step requires paused simulation time.');
    }
    pendingSingleSteps.add(this);
  }

  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0) {
      throw new Error('Time scale must be a non-negative finite number.');
    }
    this.scale = scale;
  }
}

/** Internal accumulator and monotonic timestamp state owned by App frame orchestration. */
export class TimeRuntime {
  private previousTimestampSeconds: number | undefined;
  private accumulator = 0;

  beginFrame(
    timestampSeconds: number,
    frameTime: FrameTime,
    policy: TimePolicy,
    control: TimeControl,
    diagnostics: TimeDiagnostics
  ): void {
    if (!Number.isFinite(timestampSeconds)) {
      throw new Error('Frame timestamp must be finite.');
    }
    if (
      this.previousTimestampSeconds !== undefined &&
      timestampSeconds < this.previousTimestampSeconds
    ) {
      throw new Error('Frame timestamp must be monotonic.');
    }

    const rawDelta =
      this.previousTimestampSeconds === undefined
        ? 0
        : timestampSeconds - this.previousTimestampSeconds;
    const clampedDelta = Math.min(rawDelta, policy.maxFrameDelta);
    const delta = control.paused ? 0 : clampedDelta * control.timeScale;
    if (rawDelta > clampedDelta) {
      diagnostics.clampedFrames++;
      diagnostics.clampedSeconds += rawDelta - clampedDelta;
    }
    this.previousTimestampSeconds = timestampSeconds;
    this.accumulator += delta;

    frameTime.frame++;
    frameTime.rawDelta = rawDelta;
    frameTime.delta = delta;
    frameTime.elapsed += delta;
  }

  canRunFixedStep(policy: TimePolicy): boolean {
    return this.accumulator + fixedStepEpsilon(policy.fixedStep) >= policy.fixedStep;
  }

  beginFixedStep(fixedTime: FixedTime, substep: number, consumeAccumulator = true): void {
    if (consumeAccumulator) {
      this.accumulator = Math.max(0, this.accumulator - fixedTime.step);
    }
    fixedTime.tick++;
    fixedTime.elapsed = fixedTime.tick * fixedTime.step;
    fixedTime.substep = substep;
  }

  finishFrame(
    frameTime: FrameTime,
    policy: TimePolicy,
    diagnostics: TimeDiagnostics,
    accumulatorSubsteps: number
  ): void {
    if (accumulatorSubsteps === policy.maxSubsteps && this.canRunFixedStep(policy)) {
      diagnostics.overrunFrames++;
      if (policy.overrun === 'discard') {
        const wholeSteps = Math.floor(
          (this.accumulator + fixedStepEpsilon(policy.fixedStep)) / policy.fixedStep
        );
        const dropped = wholeSteps * policy.fixedStep;
        this.accumulator = Math.max(0, this.accumulator - dropped);
        diagnostics.droppedSeconds += dropped;
      }
    }
    frameTime.interpolationAlpha = Math.min(this.accumulator / policy.fixedStep, 1);
  }
}

/** App-only control consumption; intentionally omitted from the public package surface. */
export function consumeSingleStep(control: TimeControl): boolean {
  const pending = pendingSingleSteps.has(control);
  pendingSingleSteps.delete(control);
  return pending;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Time policy ${name} must be a positive finite number.`);
  }
}

function fixedStepEpsilon(step: number): number {
  return Math.max(Number.EPSILON * 16, step * 1e-12);
}

export const FrameTimeResource = defineResource<FrameTime>('aether.time.frame');
export const FixedTimeResource = defineResource<FixedTime>('aether.time.fixed');
export const TimePolicyResource = defineResource<TimePolicy>('aether.time.policy');
export const TimeControlResource = defineResource<TimeControl>('aether.time.control');
export const TimeDiagnosticsResource = defineResource<TimeDiagnostics>('aether.time.diagnostics');
export const TimeRuntimeResource = defineResource<TimeRuntime>('aether.time.runtime');

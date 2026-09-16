import type { World } from '../ecs/world';
import { CommandBufferResource } from '../ecs/command-buffer';
import { EventRegistryResource } from '../events/event-registry';
import { StateRegistryResource } from '../events/state-registry';
import {
  FIXED_SCHEDULES,
  FRAME_AFTER_FIXED_SCHEDULES,
  FRAME_BEFORE_FIXED_SCHEDULES
} from './constants';
import type { FrameOutcome } from './runner';
import type { Schedule } from './schedule';
import type { ServiceRegistry } from './registry';
import {
  FixedTimeResource,
  FrameTimeResource,
  TimeControlResource,
  TimeDiagnosticsResource,
  TimePolicyResource,
  TimeRuntimeResource,
  consumeSingleStep
} from './time';
import type { LifecycleDiagnostic, ScheduleLabel } from './types';
import type { AppTelemetry } from './telemetry';

export interface FrameHost {
  readonly world: World;
  readonly schedules: ReadonlyMap<ScheduleLabel, Schedule>;
  readonly services: ServiceRegistry;
  readonly telemetry?: AppTelemetry;
  recordLifecycleDiagnostic(phase: LifecycleDiagnostic['phase'], error: unknown): void;
}

/**
 * Executes a single engine frame across standard before-fixed, fixed substep,
 * after-fixed, and FrameCleanup schedules. Guarantees deterministic cleanup.
 */
export function executeEngineFrame(
  host: FrameHost,
  timestampSeconds: number,
  currentFrameCount: number
): FrameOutcome {
  let primaryError: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  const { world, schedules, services, telemetry } = host;

  try {
    const frameTime = world.getResource(FrameTimeResource);
    const fixedTime = world.getResource(FixedTimeResource);
    const timePolicy = world.getResource(TimePolicyResource);
    const timeRuntime = world.getResource(TimeRuntimeResource);
    const timeControl = world.getResource(TimeControlResource);
    const timeDiagnostics = world.getResource(TimeDiagnosticsResource);

    if (frameTime && fixedTime && timePolicy && timeRuntime && timeControl && timeDiagnostics) {
      timeRuntime.beginFrame(timestampSeconds, frameTime, timePolicy, timeControl, timeDiagnostics);
    }

    for (const label of FRAME_BEFORE_FIXED_SCHEDULES) {
      schedules.get(label)?.runSync(world, 'frame', telemetry);
    }

    if (frameTime && fixedTime && timePolicy && timeRuntime && timeControl && timeDiagnostics) {
      let substep = 0;
      let accumulatorSubsteps = 0;

      if (consumeSingleStep(timeControl)) {
        substep++;
        timeRuntime.beginFixedStep(fixedTime, substep, false);
        for (const label of FIXED_SCHEDULES) {
          schedules.get(label)?.runSync(world, 'frame', telemetry);
          if (label === 'FixedPostUpdate') {
            applyCommands(world, 'after:FixedPostUpdate');
          }
        }
        advanceFixedEvents(world);
      }

      while (
        !timeControl.paused &&
        timeControl.timeScale > 0 &&
        substep < timePolicy.maxSubsteps &&
        timeRuntime.canRunFixedStep(timePolicy)
      ) {
        substep++;
        accumulatorSubsteps++;
        timeRuntime.beginFixedStep(fixedTime, substep);
        for (const label of FIXED_SCHEDULES) {
          schedules.get(label)?.runSync(world, 'frame', telemetry);
          if (label === 'FixedPostUpdate') {
            applyCommands(world, 'after:FixedPostUpdate');
          }
        }
        advanceFixedEvents(world);
      }
      timeRuntime.finishFrame(frameTime, timePolicy, timeDiagnostics, accumulatorSubsteps);
    }

    for (const label of FRAME_AFTER_FIXED_SCHEDULES) {
      schedules.get(label)?.runSync(world, 'frame', telemetry);
      if (label === 'PostUpdate') {
        applyStateTransitions(world);
        applyCommands(world, 'after:PostUpdate');
      }
    }

    applyCommands(world, 'before:FrameCleanup');
    world.getResource(EventRegistryResource)?.advanceFrame();
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    try {
      schedules.get('FrameCleanup')?.runSync(world, 'frame', telemetry);
    } catch (error) {
      cleanupErrors.push(error);
    }
    cleanupErrors.push(...services.clearFrameScoped());
    try {
      world.clearTrackers();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const error of cleanupErrors) {
      host.recordLifecycleDiagnostic('frame-cleanup', error);
    }
  }

  if (failed) {
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Frame cleanup failed.');
  }

  return Object.freeze({ frame: currentFrameCount + 1 });
}

function applyCommands(world: World, applyPoint: string): void {
  const commands = world.getResource(CommandBufferResource);
  if (commands && commands.length > 0) {
    commands.apply(world, applyPoint);
  }
}

function applyStateTransitions(world: World): void {
  const commands = world.getResource(CommandBufferResource);
  if (!commands) return;
  world.getResource(StateRegistryResource)?.applyPending(commands);
}

function advanceFixedEvents(world: World): void {
  world.getResource(EventRegistryResource)?.advanceFixedTick();
}

import { App, Schedule, definePlugin, type RunnerContext } from '../../src';

export interface ScheduleSystemSetObservation {
  readonly executedCount: number;
  readonly conditionEvaluations: number;
  readonly checksum: string;
}

/**
 * Runs a benchmark scenario with `scale` sets, each containing 4 systems.
 * Odd sets are conditioned to false, even sets to true.
 * Asserts virtual SystemSet lowering and single-condition evaluation per set.
 */
export async function runScheduleSystemSetSubject(
  scale: number
): Promise<ScheduleSystemSetObservation> {
  const app = new App();
  const trace: string[] = [];
  let conditionEvals = 0;

  app.addPlugin(
    definePlugin({
      id: 'system-set-benchmark-plugin',
      build(builder) {
        // Declare sets in order
        for (let s = 0; s < scale; s++) {
          const isEven = s % 2 === 0;
          builder.addSystemSet('Update', {
            id: `set-${s}`,
            ...(s > 0 ? { after: [`set-${s - 1}`] } : {}),
            runIf: () => {
              conditionEvals++;
              return isEven;
            }
          });

          // Add 4 members per set in reverse order
          for (let m = 3; m >= 0; m--) {
            builder.addSystem('Update', {
              id: `sys-${s}-${m}`,
              inSet: `set-${s}`,
              run: () => {
                trace.push(`sys-${s}-${m}`);
              }
            });
          }
        }
      }
    })
  );

  await app.startup();

  await app.run({
    run: async (ctx: RunnerContext) => {
      ctx.frame(0.016);
      return { reason: 'stop', frames: 1 };
    },
    requestStop: () => undefined
  });

  await app.destroy();

  return Object.freeze({
    executedCount: trace.length,
    conditionEvaluations: conditionEvals,
    checksum: checksum(trace.join(','))
  });
}

/**
 * Closed-form analytical oracle for the SystemSet benchmark.
 */
export function runScheduleSystemSetReference(scale: number): ScheduleSystemSetObservation {
  const trace: string[] = [];
  for (let s = 0; s < scale; s++) {
    if (s % 2 === 0) {
      // Due to lowest-registration-index tie-breaking:
      // Members were registered in order m = 3, 2, 1, 0
      for (let m = 3; m >= 0; m--) {
        trace.push(`sys-${s}-${m}`);
      }
    }
  }

  return Object.freeze({
    executedCount: trace.length,
    conditionEvaluations: scale, // Exactly one condition eval per set
    checksum: checksum(trace.join(','))
  });
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface ScheduleCompilationObservation {
  readonly compiledCount: number;
  readonly checksum: string;
}

/**
 * Measures schedule compilation scaling over a deterministic dependency chain.
 */
export function runScheduleCompilationSubject(systemCount: number): ScheduleCompilationObservation {
  const schedule = new Schedule('benchmark-compilation');
  for (let i = 0; i < systemCount; i++) {
    schedule.addSystem({
      id: `sys-${i}`,
      ...(i > 0 ? { after: [`sys-${i - 1}`] } : {}),
      run: () => undefined
    });
  }
  const order = schedule.compile();
  return Object.freeze({
    compiledCount: order.length,
    checksum: checksum(order.map((n) => n.id).join(','))
  });
}

export function runScheduleCompilationReference(
  systemCount: number
): ScheduleCompilationObservation {
  const ids: string[] = [];
  for (let i = 0; i < systemCount; i++) {
    ids.push(`sys-${i}`);
  }
  return Object.freeze({
    compiledCount: systemCount,
    checksum: checksum(ids.join(','))
  });
}

export interface TelemetryOverheadObservation {
  readonly clockSamples: number;
  readonly emittedEvents: number;
  readonly framesExecuted: number;
}

/**
 * Asserts empirical clock sampling counts under enabled vs disabled telemetry.
 */
export async function runTelemetryOverheadSubject(
  enabled: boolean,
  frames: number
): Promise<TelemetryOverheadObservation> {
  let clockSamples = 0;
  const app = new App({
    telemetry: {
      enabled,
      recordSystemSpans: enabled,
      clock: { now: () => ++clockSamples }
    }
  });

  app.addPlugin(
    definePlugin({
      id: 'telemetry-benchmark-plugin',
      build(builder) {
        builder.addSystem('Update', {
          id: 'bench-sys',
          run: () => undefined
        });
      }
    })
  );

  await app.startup();
  clockSamples = 0;

  await app.run({
    run: async (ctx: RunnerContext) => {
      for (let f = 0; f < frames; f++) {
        ctx.frame(f * 0.016);
      }
      return { reason: 'stop', frames };
    },
    requestStop: () => undefined
  });

  const emittedEvents = app.telemetryEvents.getEvents().length;
  await app.destroy();

  return Object.freeze({
    clockSamples,
    emittedEvents,
    framesExecuted: frames
  });
}

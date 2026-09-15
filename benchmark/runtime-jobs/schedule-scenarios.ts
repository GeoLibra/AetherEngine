import { App, definePlugin } from '../../src';

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
    run: async (ctx: any) => {
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

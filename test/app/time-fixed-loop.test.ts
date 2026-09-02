import { describe, expect, test } from 'vitest';
import {
  App,
  FixedTimeResource,
  FrameTimeResource,
  HeadlessRunner,
  TimeControl,
  TimeControlResource,
  TimeDiagnosticsResource,
  TimePolicy,
  TimePolicyResource,
  createTimePlugin,
  createServiceToken,
  definePlugin,
  serviceFactory,
  type AppExit,
  type Runner,
  type RunnerContext,
  type TimePolicyOptions
} from '../../src';

class TimestampRunner implements Runner {
  constructor(private readonly timestamps: readonly number[]) {}

  async run(context: RunnerContext): Promise<AppExit> {
    let frames = 0;
    for (const timestamp of this.timestamps) {
      if (context.stopRequested) {
        break;
      }
      context.frame(timestamp);
      frames++;
    }
    return Object.freeze({ reason: 'completed', frames });
  }

  requestStop(): void {}
}

describe('Time and fixed schedules', () => {
  test('uses runner timestamps to advance variable and fixed time', async () => {
    const fixedTicks: number[] = [];
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 })).addPlugin(
      definePlugin({
        id: 'test.fixed-observer',
        build(builder) {
          builder.addSystem('FixedUpdate', {
            id: 'record-fixed-tick',
            run(world) {
              fixedTicks.push(world.getResource(FixedTimeResource)?.tick ?? -1);
            }
          });
        }
      })
    );

    await app.run(new TimestampRunner([0, 0.01, 0.03]));

    expect(fixedTicks).toEqual([1]);
    const frameTime = app.getResource(FrameTimeResource);
    expect(frameTime?.frame).toBe(3);
    expect(frameTime?.rawDelta).toBeCloseTo(0.02);
    expect(frameTime?.delta).toBeCloseTo(0.02);
    expect(frameTime?.elapsed).toBeCloseTo(0.03);
    expect(frameTime?.interpolationAlpha).toBeCloseTo(0.5);

    const fixedTime = app.getResource(FixedTimeResource);
    expect(fixedTime?.tick).toBe(1);
    expect(fixedTime?.step).toBeCloseTo(0.02);
    expect(fixedTime?.elapsed).toBeCloseTo(0.02);
    expect(fixedTime?.maxSubsteps).toBe(5);
  });

  test('clamps large frames and reports discarded fixed-step backlog', async () => {
    const app = new App().addPlugin(
      createTimePlugin({ fixedStep: 0.02, maxSubsteps: 2, maxFrameDelta: 0.1 })
    );

    await app.run(new TimestampRunner([0, 1]));

    const frameTime = app.getResource(FrameTimeResource);
    expect(frameTime?.rawDelta).toBe(1);
    expect(frameTime?.delta).toBe(0.1);
    expect(frameTime?.interpolationAlpha).toBeCloseTo(0);
    expect(app.getResource(FixedTimeResource)?.tick).toBe(2);

    const diagnostics = app.getResource(TimeDiagnosticsResource);
    expect(diagnostics?.clampedFrames).toBe(1);
    expect(diagnostics?.clampedSeconds).toBeCloseTo(0.9);
    expect(diagnostics?.overrunFrames).toBe(1);
    expect(diagnostics?.droppedSeconds).toBeCloseTo(0.06);
  });

  test('applies time scale before accumulating fixed time', async () => {
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 }));
    await app.startup();
    app.getResource(TimeControlResource)?.setTimeScale(0.5);

    await app.run(new TimestampRunner([0, 0.04]));

    expect(app.getResource(FrameTimeResource)?.rawDelta).toBeCloseTo(0.04);
    expect(app.getResource(FrameTimeResource)?.delta).toBeCloseTo(0.02);
    expect(app.getResource(FrameTimeResource)?.elapsed).toBeCloseTo(0.02);
    expect(app.getResource(FixedTimeResource)?.tick).toBe(1);
  });

  test('pause freezes simulation time while variable schedules continue', async () => {
    let updates = 0;
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 })).addPlugin(
      definePlugin({
        id: 'test.variable-observer',
        build(builder) {
          builder.addSystem('Update', {
            id: 'record-variable-update',
            run: () => void updates++
          });
        }
      })
    );
    await app.startup();
    app.getResource(TimeControlResource)?.pause();

    await app.run(new TimestampRunner([0, 0.1]));

    expect(updates).toBe(2);
    expect(app.getResource(FrameTimeResource)?.rawDelta).toBeCloseTo(0.1);
    expect(app.getResource(FrameTimeResource)?.delta).toBe(0);
    expect(app.getResource(FrameTimeResource)?.elapsed).toBe(0);
    expect(app.getResource(FixedTimeResource)?.tick).toBe(0);
  });

  test('single-step runs exactly one fixed tick while paused', async () => {
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 }));
    await app.startup();
    const control = app.getResource(TimeControlResource);
    control?.pause();
    control?.requestSingleStep();

    await app.run(new TimestampRunner([0, 0.1]));

    expect(app.getResource(FixedTimeResource)?.tick).toBe(1);
    expect(app.getResource(FixedTimeResource)?.elapsed).toBeCloseTo(0.02);
    expect(app.getResource(FrameTimeResource)?.delta).toBe(0);
  });

  test('runs fixed schedules between PreUpdate and Update', async () => {
    const order: string[] = [];
    const schedules = [
      'First',
      'PreUpdate',
      'FixedFirst',
      'FixedPreUpdate',
      'FixedUpdate',
      'FixedPostUpdate',
      'FixedLast',
      'Update',
      'PostUpdate',
      'Last',
      'PreRender',
      'Render',
      'PostRender'
    ] as const;
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 })).addPlugin(
      definePlugin({
        id: 'test.schedule-order',
        build(builder) {
          for (const schedule of schedules) {
            builder.addSystem(schedule, {
              id: `record-${schedule}`,
              run(world) {
                if (world.getResource(FrameTimeResource)?.frame === 2) {
                  order.push(schedule);
                }
              }
            });
          }
        }
      })
    );

    await app.run(new TimestampRunner([0, 0.02]));

    expect(order).toEqual(schedules);
  });

  test('single-step preserves retained backlog without reporting another overrun', async () => {
    const app = new App().addPlugin(
      createTimePlugin({ fixedStep: 0.02, maxSubsteps: 1, overrun: 'retain' })
    );
    await app.startup();
    const control = app.getResource(TimeControlResource);
    const runner: Runner = {
      async run(context) {
        context.frame(0);
        context.frame(0.04);
        control?.pause();
        control?.requestSingleStep();
        context.frame(0.05);
        return Object.freeze({ reason: 'completed', frames: 3 });
      },
      requestStop() {}
    };

    await app.run(runner);

    expect(app.getResource(FixedTimeResource)?.tick).toBe(2);
    expect(app.getResource(FrameTimeResource)?.interpolationAlpha).toBe(1);
    expect(app.getResource(TimeDiagnosticsResource)?.overrunFrames).toBe(1);
  });

  test('zero time scale freezes retained fixed-step backlog', async () => {
    const app = new App().addPlugin(
      createTimePlugin({ fixedStep: 0.02, maxSubsteps: 1, overrun: 'retain' })
    );
    await app.startup();
    const control = app.getResource(TimeControlResource);
    const runner: Runner = {
      async run(context) {
        context.frame(0);
        context.frame(0.04);
        control?.setTimeScale(0);
        context.frame(0.05);
        return Object.freeze({ reason: 'completed', frames: 3 });
      },
      requestStop() {}
    };

    await app.run(runner);

    expect(app.getResource(FixedTimeResource)?.tick).toBe(1);
    expect(app.getResource(FrameTimeResource)?.interpolationAlpha).toBe(1);
  });

  test('snapshots plugin policy options when the plugin is created', async () => {
    const options = { fixedStep: 0.02 };
    const plugin = createTimePlugin(options);
    options.fixedStep = 0.1;
    const app = new App().addPlugin(plugin);

    await app.run(new TimestampRunner([0, 0.02]));

    expect(app.getResource(TimePolicyResource)?.fixedStep).toBeCloseTo(0.02);
    expect(app.getResource(FixedTimeResource)?.tick).toBe(1);
  });

  test('HeadlessRunner advances a deterministic timestamp sequence', async () => {
    const app = new App().addPlugin(createTimePlugin({ fixedStep: 0.02 }));

    await app.run(new HeadlessRunner({ frames: 3, frameDelta: 0.02, startTime: 10 }));

    expect(app.getResource(FrameTimeResource)?.elapsed).toBeCloseTo(0.04);
    expect(app.getResource(FixedTimeResource)?.tick).toBe(2);
  });

  test('non-monotonic timestamps fail the frame and still release frame services', async () => {
    const FrameLease = createServiceToken<object>('time-test-frame-lease');
    let disposals = 0;
    const app = new App().addPlugin(createTimePlugin()).addPlugin(
      definePlugin({
        id: 'test.frame-cleanup',
        build(builder) {
          builder.provideService(
            FrameLease,
            serviceFactory(() => ({}), {
              lifecycle: 'frame',
              dispose: () => void disposals++
            })
          );
        }
      })
    );
    await app.startup();
    const runner: Runner = {
      async run(context) {
        context.frame(1);
        app.getService(FrameLease);
        context.frame(0.5);
        return Object.freeze({ reason: 'completed', frames: 2 });
      },
      requestStop() {}
    };

    await expect(app.run(runner)).rejects.toThrow('Frame timestamp must be monotonic.');

    expect(disposals).toBe(1);
    expect(app.state).toBe('failed');
  });

  test('rejects invalid time policy and control values', () => {
    expect(() => new TimePolicy({ fixedStep: 0 })).toThrow('fixedStep');
    expect(() => new TimePolicy({ maxSubsteps: 0 })).toThrow('maxSubsteps');
    expect(() => new TimePolicy({ maxFrameDelta: Number.NaN })).toThrow('maxFrameDelta');
    const invalidOverrun = { overrun: 'invalid' } as unknown as TimePolicyOptions;
    expect(() => new TimePolicy(invalidOverrun)).toThrow('overrun');

    const control = new TimeControl();
    expect(() => control.setTimeScale(-1)).toThrow('Time scale');
    expect(() => control.requestSingleStep()).toThrow('requires paused');
  });
});

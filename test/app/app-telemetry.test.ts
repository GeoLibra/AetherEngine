import { describe, expect, test } from 'vitest';
import {
  App,
  AppTelemetry,
  definePlugin,
  type AppTelemetryEvent,
  type MonotonicClock
} from '../../src';

describe('App Telemetry and Observability', () => {
  class FakeClock implements MonotonicClock {
    private time = 1000;
    now(): number {
      return this.time;
    }
    advance(ms: number): void {
      this.time += ms;
    }
  }

  test('records lifecycle spans for build, prepare, finish, and shutdown with injected clock', async () => {
    const clock = new FakeClock();
    const recordedEvents: AppTelemetryEvent[] = [];

    const app = new App({
      telemetry: {
        enabled: true,
        clock
      }
    });

    app.telemetryEvents.subscribe((e) => recordedEvents.push(e));

    app.addPlugin(
      definePlugin({
        id: 'telemetry-plugin',
        build: () => {
          clock.advance(10);
        },
        prepare: () => {
          clock.advance(25);
        },
        finish: () => {
          clock.advance(15);
        },
        shutdown: () => {
          clock.advance(5);
        }
      })
    );

    await app.startup();
    await app.destroy();

    const pluginEvents = recordedEvents.filter(
      (e) => 'pluginId' in e && e.pluginId === 'telemetry-plugin'
    );

    expect(pluginEvents.map((e) => e.kind)).toEqual([
      'plugin-start',
      'plugin-complete',
      'plugin-start',
      'plugin-complete',
      'plugin-start',
      'plugin-complete',
      'plugin-start',
      'plugin-complete'
    ]);

    const buildComplete = pluginEvents.find(
      (e) => e.kind === 'plugin-complete' && (e as any).phase === 'build'
    ) as any;
    expect(buildComplete?.durationMs).toBe(10);

    const prepareComplete = pluginEvents.find(
      (e) => e.kind === 'plugin-complete' && (e as any).phase === 'prepare'
    ) as any;
    expect(prepareComplete?.durationMs).toBe(25);

    const finishComplete = pluginEvents.find(
      (e) => e.kind === 'plugin-complete' && (e as any).phase === 'finish'
    ) as any;
    expect(finishComplete?.durationMs).toBe(15);

    const shutdownComplete = pluginEvents.find(
      (e) => e.kind === 'plugin-complete' && (e as any).phase === 'shutdown'
    ) as any;
    expect(shutdownComplete?.durationMs).toBe(5);
  });

  test('records schedule compilation events', async () => {
    const app = new App({
      telemetry: { enabled: true }
    });

    app.addPlugin(
      definePlugin({
        id: 'simple-plugin',
        build(builder) {
          builder.addSystem('Update', {
            id: 'simple-sys',
            run: () => undefined
          });
        }
      })
    );

    await app.startup();

    const compileEvents = app.telemetryEvents
      .getEvents()
      .filter((e) => e.kind === 'schedule-compile-complete');

    expect(compileEvents.length).toBeGreaterThanOrEqual(1);
    const updateCompile = compileEvents.find((e) => (e as any).schedule === 'Update') as any;
    expect(updateCompile).toBeDefined();
    expect(updateCompile.systemCount).toBe(1);
  });

  test('records system spans when recordSystemSpans is enabled', async () => {
    const clock = new FakeClock();
    const app = new App({
      telemetry: {
        enabled: true,
        recordSystemSpans: true,
        clock
      }
    });

    app.addPlugin(
      definePlugin({
        id: 'span-plugin',
        build(builder) {
          builder.addSystem('Update', {
            id: 'timed-system',
            run: () => {
              clock.advance(42);
            }
          });
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

    const spans = app.telemetryEvents.getEvents().filter((e) => e.kind === 'system-span') as any[];

    const timedSpan = spans.find((s) => s.systemId === 'timed-system');
    expect(timedSpan).toBeDefined();
    expect(timedSpan.durationMs).toBe(42);
  });

  test('bounded ring buffer drops oldest events and increments dropped count', () => {
    const telemetry = new AppTelemetry({
      enabled: true,
      bufferCapacity: 3
    });

    for (let i = 0; i < 5; i++) {
      telemetry.recordPluginStart(`p-${i}`, 'build');
    }

    expect(telemetry.droppedEvents).toBe(2);
    const events = telemetry.getEvents();
    expect(events).toHaveLength(3);
    expect((events[0] as any).pluginId).toBe('p-2');
    expect((events[2] as any).pluginId).toBe('p-4');
  });

  test('subscriber failure does not disrupt telemetry emission or engine execution', async () => {
    const app = new App({
      telemetry: { enabled: true }
    });

    app.telemetryEvents.subscribe(() => {
      throw new Error('faulty subscriber');
    });

    app.addPlugin(definePlugin({ id: 'safe-plugin', build: () => undefined }));
    await expect(app.startup()).resolves.toBeUndefined();
  });

  test('disabled telemetry records zero events and maintains zero overhead', async () => {
    const app = new App(); // disabled by default
    expect(app.telemetryEvents.isEnabled).toBe(false);

    app.addPlugin(
      definePlugin({
        id: 'unrecorded-plugin',
        build(builder) {
          builder.addSystem('Update', {
            id: 'unrecorded-sys',
            run: () => undefined
          });
        }
      })
    );

    await app.startup();
    expect(app.telemetryEvents.getEvents()).toEqual([]);
  });
});

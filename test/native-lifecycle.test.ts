import { describe, expect, test } from 'vitest';

import {
  NativeLifecycleCoordinator,
  NativeLifecycleTerminationError,
  createNativeCrashReport,
  type NativeBackgroundPolicy,
  type NativeLifecycleSnapshot
} from '../src';

const POLICY: NativeBackgroundPolicy = Object.freeze({
  simulation: 'pause', render: 'pause', audio: 'pause'
});

describe('NativeLifecycleCoordinator', () => {
  test('publishes immutable foreground/background and platform lifecycle snapshots', () => {
    const coordinator = new NativeLifecycleCoordinator(POLICY);
    const snapshots: NativeLifecycleSnapshot[] = [];
    coordinator.subscribe((snapshot) => snapshots.push(snapshot));

    coordinator.background();
    coordinator.audioInterrupted(true);
    coordinator.orientation('landscape');
    coordinator.resize([800, 600]);
    coordinator.surfaceLost(4);
    coordinator.surfaceRecreated(5);
    coordinator.foreground();

    expect(snapshots.map((snapshot) => snapshot.kind)).toEqual([
      'background', 'audio-interruption', 'orientation', 'resize',
      'surface-lost', 'surface-recreated', 'foreground'
    ]);
    expect(snapshots[0]).toMatchObject({ policy: POLICY });
    expect(snapshots.every(Object.isFrozen)).toBe(true);
  });

  test('runs memory eviction in priority/budget order and diagnoses insufficiency', () => {
    const coordinator = new NativeLifecycleCoordinator(POLICY);
    const calls: string[] = [];
    coordinator.registerEvictor({ name: 'optional', priority: 20, evict: (budget) => { calls.push(`optional:${budget}`); return 30; } });
    coordinator.registerEvictor({ name: 'critical', priority: 10, evict: (budget) => { calls.push(`critical:${budget}`); return 40; } });

    const result = coordinator.memoryPressure({ severity: 'critical', targetBytes: 100, maxCallbacks: 2 });

    expect(calls).toEqual(['critical:100', 'optional:60']);
    expect(result).toEqual({
      requestedBytes: 100, evictedBytes: 70, sufficient: false, callbacks: 2,
      failedEvictors: []
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('terminates once, runs every cleanup, and aggregates failures', () => {
    const coordinator = new NativeLifecycleCoordinator(POLICY);
    const calls: string[] = [];
    coordinator.registerCleanup(() => { calls.push('first'); throw new Error('one'); });
    coordinator.registerCleanup(() => { calls.push('second'); throw new Error('two'); });
    coordinator.registerCleanup(() => { calls.push('third'); });

    expect(() => coordinator.terminate()).toThrow(NativeLifecycleTerminationError);
    expect(calls).toEqual(['first', 'second', 'third']);
    expect(coordinator.terminate()).toBe(false);
  });
});

describe('native crash diagnostics', () => {
  test('bounds telemetry and redacts secrets, paths, URI queries, text, and payloads', () => {
    const report = createNativeCrashReport({
      jsException: 'failed at /Users/person/game.ts?token=secret',
      nativeStack: 'frame C:\\Users\\person\\native.cc',
      device: { model: 'phone', authorizationToken: 'abc' },
      recentTelemetry: [
        { event: 'old' },
        { event: 'clipboard', text: 'private words' },
        { event: 'network', payload: 'secret bytes', uri: 'https://host/api?q=private' }
      ]
    }, { telemetryLimit: 2, maxStringLength: 120 });
    const serialized = JSON.stringify(report);

    expect(report.recentTelemetry).toHaveLength(2);
    expect(serialized).not.toContain('person');
    expect(serialized).not.toContain('private words');
    expect(serialized).not.toContain('secret bytes');
    expect(serialized).not.toContain('q=private');
    expect(serialized).not.toContain('abc');
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.recentTelemetry)).toBe(true);
  });
});

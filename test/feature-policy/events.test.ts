import { describe, expect, test } from 'vitest';
import {
  createBrowserFeaturePolicySource,
  createNativeFeaturePolicySource,
  type BrowserGraphicsLifecycleEvent,
  type BrowserGraphicsSession,
  type FeaturePolicySourceEvent
} from '../../src';
import { NativeLifecycleCoordinator } from '../../src/native-runtime/lifecycle';
import type { RHIDevice } from '../../src/rhi/contracts/device';
import type { RHISurface } from '../../src/rhi/contracts/surface';

describe('FeaturePolicy platform event sources', () => {
  test('maps browser reconfiguration and loss to current graphics facts', () => {
    let lifecycle: ((event: BrowserGraphicsLifecycleEvent) => void) | undefined;
    const device = {} as RHIDevice;
    const surface = {} as RHISurface;
    const session = {
      device,
      surface,
      subscribe(listener: (event: BrowserGraphicsLifecycleEvent) => void) {
        lifecycle = listener;
        return () => true;
      }
    } as BrowserGraphicsSession;
    const events: FeaturePolicySourceEvent[] = [];

    createBrowserFeaturePolicySource(session).subscribe((event) => events.push(event));
    lifecycle?.({ kind: 'reconfigured', generation: 2 });
    lifecycle?.({
      kind: 'lost',
      loss: {
        backend: 'webgpu',
        stage: 'device',
        reason: 'reset',
        generation: 1,
        recreationAllowed: true
      }
    });

    expect(events).toEqual([
      { kind: 'graphics-changed', device, surface },
      { kind: 'graphics-changed', device, surface }
    ]);
  });

  test('maps native surface changes and memory pressure to separate source domains', () => {
    const lifecycle = new NativeLifecycleCoordinator({
      simulation: 'pause',
      render: 'pause',
      audio: 'pause'
    });
    const device = {} as RHIDevice;
    const surface = {} as RHISurface;
    const events: FeaturePolicySourceEvent[] = [];
    createNativeFeaturePolicySource(lifecycle, () => ({ device, surface })).subscribe((event) =>
      events.push(event)
    );

    lifecycle.resize([640, 360]);
    lifecycle.memoryPressure({ severity: 'moderate', targetBytes: 0, maxCallbacks: 0 });

    expect(events).toEqual([
      { kind: 'graphics-changed', device, surface },
      { kind: 'budget-changed' }
    ]);
  });
});

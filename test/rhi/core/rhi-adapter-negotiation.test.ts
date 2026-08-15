import { describe, expect, test } from 'vitest';
import { NullAdapter, RHIDeviceRequestError } from '../../../src';
import { createCapabilitySnapshot } from '../../../src/rhi/core/capabilities';
import type {
  FeatureSupport,
  FormatCapabilities,
  QueueCapability,
  RHIFeature,
  RHILimits
} from '../../../src/rhi/contracts/capability';

describe('NullAdapter negotiation', () => {
  test('seals the read-only capability map without exposing its copied backing map', () => {
    const snapshot = createCapabilitySnapshot({
      backend: 'null',
      features: new Map([['compute', { status: 'native' }]]),
      limits: {},
      formats: new Map(),
      queues: []
    });
    const features = snapshot.features;

    expect(Object.isFrozen(features)).toBe(true);
    expect(() => Object.assign(features, { debugState: true })).toThrow();
    expect(() => Object.assign(features, { size: 999 })).toThrow();
    expect(Reflect.ownKeys(features)).toEqual([]);
    expect(Object.values(features).some((value) => value instanceof Map)).toBe(false);
    expect(features.get('compute')).toEqual({ status: 'native' });
    expect([...features.keys()]).toEqual(['compute']);
  });

  test('publishes detached capability maps through an enforcing read-only facade', () => {
    const nestedExtra = { callerOwned: true };
    const feature = { status: 'native', nestedExtra } as FeatureSupport & { nestedExtra: object };
    const sampleCounts = [1, 4];
    const format = {
      sample: true,
      filter: true,
      render: true,
      blend: true,
      storage: false,
      copySrc: true,
      copyDst: true,
      sampleCounts,
      nestedExtra
    } as FormatCapabilities & { nestedExtra: object };
    const limits = { maxBufferSize: 1024, nestedExtra } as unknown as RHILimits & {
      nestedExtra: object;
    };
    const queue = {
      role: 'graphics',
      status: 'native',
      nestedExtra
    } as QueueCapability & { nestedExtra: object };
    const features = new Map<RHIFeature, FeatureSupport>([['compute', feature]]);
    const snapshot = createCapabilitySnapshot({
      backend: 'null',
      features,
      limits,
      formats: new Map([['rgba8unorm', format]]),
      queues: [queue]
    });

    features.set('compute', { status: 'unsupported', reason: 'caller mutation' });
    sampleCounts[0] = 8;
    nestedExtra.callerOwned = false;

    expect(snapshot.features.get('compute')).toEqual({ status: 'native' });
    expect('set' in snapshot.features).toBe(false);
    expect(Object.keys(snapshot.features)).toEqual([]);
    expect(Object.getOwnPropertyNames(snapshot.features)).toEqual([]);
    expect('entriesMap' in snapshot.features).toBe(false);
    expect(
      (snapshot.features as unknown as { entriesMap?: Map<unknown, unknown> }).entriesMap
    ).toBeUndefined();
    expect(snapshot.formats.get('rgba8unorm')).toMatchObject({ sampleCounts: [1, 4] });
    expect(snapshot.limits).toEqual({ maxBufferSize: 1024 });
    expect(snapshot.queues).toEqual([{ role: 'graphics', status: 'native' }]);
    expect('nestedExtra' in snapshot.features.get('compute')!).toBe(false);
    expect('nestedExtra' in snapshot.formats.get('rgba8unorm')!).toBe(false);
    expect('nestedExtra' in snapshot.limits).toBe(false);
    expect('nestedExtra' in snapshot.queues[0]!).toBe(false);
  });

  test('creates a device when required facts are satisfied', async () => {
    const adapter = new NullAdapter({
      name: 'Profile Adapter',
      features: { compute: { status: 'native' } },
      limits: { maxBufferSize: 4096 }
    });

    const device = await adapter.requestDevice({
      requiredFeatures: ['compute'],
      optionalFeatures: ['timestamp-query'],
      requiredLimits: { maxBufferSize: 1024 },
      label: 'negotiated'
    });

    expect(adapter.info).toEqual({ name: 'Profile Adapter', backend: 'null' });
    expect(device.capabilities.features.get('compute')?.status).toBe('native');
    expect(device.capabilities.features.get('timestamp-query')).toEqual({
      status: 'unsupported',
      reason: 'Not configured by the NullAdapter profile.'
    });
    expect(device.capabilities.limits.maxBufferSize).toBe(4096);
    expect(Object.isFrozen(device.capabilities)).toBe(true);
    expect('set' in device.capabilities.features).toBe(false);
  });

  test('rejects missing required features and limits with explicit differences', async () => {
    const adapter = new NullAdapter({ limits: { maxBufferSize: 512 } });

    const request = adapter.requestDevice({
      requiredFeatures: ['compute'],
      optionalFeatures: [],
      requiredLimits: { maxBufferSize: 1024 }
    });

    await expect(request).rejects.toMatchObject({
      code: 'rhi/device-request-failed',
      missing: [
        { kind: 'feature', feature: 'compute' },
        { kind: 'limit', limit: 'maxBufferSize', minimum: 1024, actual: 512 }
      ]
    });
    await expect(request).rejects.toBeInstanceOf(RHIDeviceRequestError);
  });

  test('publishes mutation-resistant device request differences', async () => {
    const adapter = new NullAdapter({ limits: { maxBufferSize: 512 } });
    let failure: RHIDeviceRequestError | undefined;

    try {
      await adapter.requestDevice({
        requiredFeatures: ['compute'],
        optionalFeatures: [],
        requiredLimits: { maxBufferSize: 1024 }
      });
    } catch (error) {
      if (error instanceof RHIDeviceRequestError) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    expect(Object.isFrozen(failure!.missing)).toBe(true);
    expect(Object.isFrozen(failure!.missing[0])).toBe(true);
    expect(() => Object.assign(failure!.missing[0]!, { feature: 'timestamp-query' })).toThrow();
    expect(() => Object.assign(failure!.missing[1]!, { minimum: 1 })).toThrow();
    expect(failure!.missing).toEqual([
      { kind: 'feature', feature: 'compute' },
      { kind: 'limit', limit: 'maxBufferSize', minimum: 1024, actual: 512 }
    ]);
  });
});

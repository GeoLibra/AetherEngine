import { describe, expect, test } from 'vitest';
import { NullAdapter, RHIDeviceRequestError } from '../../../src';
import { createCapabilitySnapshot } from '../../../src/rhi/core/capabilities';
import type { FeatureSupport, RHIFeature } from '../../../src/rhi/contracts/capability';

describe('NullAdapter negotiation', () => {
  test('publishes detached capability maps through an enforcing read-only facade', () => {
    const features = new Map<RHIFeature, FeatureSupport>([['compute', { status: 'native' }]]);
    const snapshot = createCapabilitySnapshot({
      backend: 'null',
      features,
      limits: {},
      formats: new Map(),
      queues: [{ role: 'graphics', status: 'native' }]
    });

    features.set('compute', { status: 'unsupported', reason: 'caller mutation' });

    expect(snapshot.features.get('compute')).toEqual({ status: 'native' });
    expect('set' in snapshot.features).toBe(false);
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
});

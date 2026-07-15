import { describe, expect, test } from 'vitest';
import { NullAdapter, RHIDeviceRequestError } from '../../../src';

describe('NullAdapter negotiation', () => {
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

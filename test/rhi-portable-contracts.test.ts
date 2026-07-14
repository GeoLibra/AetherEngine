import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  RHIUnsupportedOperationError,
  type AdapterCapabilities,
  type AdapterInfo,
  type DeviceCapabilities,
  type DeviceRequest,
  type DeviceLostInfo,
  type FeatureSupport,
  type FormatCapabilities,
  type RHIAdapter,
  type RHIBufferDescriptor,
  type RHICapabilityRequirement,
  type RHIFeature,
  type RHISubmission,
  type RHISurface,
  type RHISurfaceConfiguration,
  type RHITextureDescriptor
} from '../src';

function createCapabilities(): DeviceCapabilities {
  const format: FormatCapabilities = {
    sample: true,
    filter: true,
    render: true,
    blend: true,
    storage: false,
    copySrc: true,
    copyDst: true,
    sampleCounts: [1, 4]
  };
  return Object.freeze({
    backend: 'null',
    features: new Map<RHIFeature, FeatureSupport>([
      ['compute', { status: 'unsupported', reason: 'profile' }]
    ]),
    limits: Object.freeze({ maxBufferSize: 1024 }),
    formats: new Map([['rgba8unorm', format]]),
    queues: Object.freeze([{ role: 'graphics' as const, status: 'native' as const }])
  });
}

describe('Portable RHI public contracts', () => {
  test('publish backend-neutral Adapter, Device, Submission, and Surface shapes', () => {
    const info: AdapterInfo = { name: 'Null Adapter', backend: 'null' };
    const adapterCapabilities: AdapterCapabilities = createCapabilities();
    const request: DeviceRequest = {
      requiredFeatures: [],
      optionalFeatures: ['compute'],
      requiredLimits: { maxBufferSize: 512 },
      label: 'test-device'
    };
    const surfaceConfiguration: RHISurfaceConfiguration = {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 640,
      height: 360,
      presentMode: 'fifo'
    };

    expect(info.backend).toBe('null');
    expect(adapterCapabilities.backend).toBe('null');
    expect(request.optionalFeatures).toEqual(['compute']);
    expect(surfaceConfiguration.width).toBe(640);
    expectTypeOnly<RHIAdapter>();
    expectTypeOnly<RHISubmission>();
    expectTypeOnly<RHISurface>();
    expectTypeOnly<DeviceLostInfo>();
  });

  test('publish canonical portable descriptor names', () => {
    const buffer: RHIBufferDescriptor = { size: 64, usage: 1 };
    const texture: RHITextureDescriptor = {
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 16
    };

    expect(buffer.size).toBe(64);
    expect(texture.format).toBe('rgba8unorm');
  });

  test('keeps capability facts on the canonical capabilities snapshot only', () => {
    const device = new NullDevice();

    expect('features' in device).toBe(false);
    expect('limits' in device).toBe(false);
  });

  test('return a stable typed unsupported-operation diagnostic', () => {
    const actual = createCapabilities();
    const required: readonly RHICapabilityRequirement[] = Object.freeze([
      Object.freeze({ kind: 'feature', feature: 'compute' })
    ]);

    const error = new RHIUnsupportedOperationError(
      'create-compute-pipeline',
      required,
      actual
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('rhi/unsupported-operation');
    expect(error.operation).toBe('create-compute-pipeline');
    expect(error.required).toBe(required);
    expect(error.actual).toBe(actual);
    expect(error.message).toBe(
      'RHI operation create-compute-pipeline is unsupported by this device.'
    );
  });
});

function expectTypeOnly<T>(): void {
  void (undefined as T | undefined);
}

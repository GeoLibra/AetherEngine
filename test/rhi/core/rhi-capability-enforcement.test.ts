import { describe, expect, test } from 'vitest';
import { NullAdapter, NullDevice, RHIUnsupportedOperationError } from '../../../src';

async function createRestrictedDevice() {
  return new NullAdapter().requestDevice({
    requiredFeatures: [],
    optionalFeatures: ['compute', 'storage-buffer', 'storage-texture', 'indirect-draw']
  });
}

describe('RHI capability enforcement', () => {
  test('keeps compute methods present but rejects unsupported use consistently', async () => {
    const device = await createRestrictedDevice();

    expect(() => device.createComputePipeline({ label: 'unsupported-compute' })).toThrow(
      RHIUnsupportedOperationError
    );
    expect(() => device.createComputePipeline()).toThrowError(
      expect.objectContaining({
        code: 'rhi/unsupported-operation',
        operation: 'create-compute-pipeline',
        required: [{ kind: 'feature', feature: 'compute' }],
        actual: device.capabilities
      })
    );
    expect(() => device.createCommandEncoder().beginComputePass()).toThrowError(
      expect.objectContaining({ operation: 'begin-compute-pass' })
    );
  });

  test('rejects storage bindings without changing their high-level semantics', async () => {
    const device = await createRestrictedDevice();

    expect(() =>
      device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'storage' } }]
      })
    ).toThrowError(expect.objectContaining({ operation: 'create-storage-buffer' }));
    expect(() =>
      device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            storageTexture: { access: 'write-only', format: 'rgba8unorm' }
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ operation: 'create-storage-texture' }));
  });

  test('lets the full Null conformance profile exercise the complete method surface', () => {
    const device = new NullDevice();

    expect(device.capabilities.features.get('compute')?.status).toBe('native');
    expect(() => device.createComputePipeline()).not.toThrow();
    const pass = device.createCommandEncoder().beginComputePass();
    expect(() => pass.end()).not.toThrow();
  });
});

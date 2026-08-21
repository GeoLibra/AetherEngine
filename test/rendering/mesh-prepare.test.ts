import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  PreparedAssetRegistry,
  disposePreparedMesh,
  prepareMesh,
  validateMeshData,
  type MeshDataInput
} from '../../src';
import type { RHIBuffer } from '../../src/rhi/contracts';
import type { RHIBufferDescriptor } from '../../src/rhi/contracts/descriptor';

const meshInput: MeshDataInput = {
  topology: 'triangles',
  vertexCount: 3,
  streams: [
    {
      semantic: 'POSITION',
      format: 'float32x3',
      stride: 12,
      offset: 0,
      count: 3,
      data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    }
  ],
  indices: { format: 'u16', data: new Uint16Array([0, 1, 2]) },
  submeshes: [{ start: 0, count: 3, materialSlot: 0 }]
};

describe('mesh GPU preparation', () => {
  test('uploads isolated vertex/index data and publishes a generation-aware variant', async () => {
    const device = new NullDevice();
    const prepared = prepareMesh(device, validateMeshData(meshInput), {
      assetId: 'mesh:triangle',
      payloadVersion: 4,
      featurePolicyKey: 'policy-a',
      abiVersion: 'mesh-v1'
    });

    expect(prepared.key).toEqual({
      assetId: 'mesh:triangle',
      payloadVersion: 4,
      deviceGeneration: device.generation,
      featurePolicyKey: 'policy-a',
      abiVersion: 'mesh-v1'
    });
    expect(prepared.value.layout.streams[0]).toMatchObject({
      semantic: 'POSITION',
      format: 'float32x3',
      stride: 12,
      offset: 0
    });
    await prepared.value.vertexBuffers[0]!.mapAsync(0);
    expect(Array.from(new Float32Array(prepared.value.vertexBuffers[0]!.getMappedRange()))).toEqual(
      Array.from(meshInput.streams[0]!.data as Float32Array)
    );
    prepared.value.vertexBuffers[0]!.unmap();

    const registry = new PreparedAssetRegistry();
    registry.publish(prepared, disposePreparedMesh);
    const lease = registry.acquire(prepared.key)!;
    expect(lease.prepared.value).toBe(prepared.value);
    registry.retire(prepared.key);
    expect(prepared.value.vertexBuffers[0]!.state).toBe('live');
    lease.dispose();
    expect(prepared.value.vertexBuffers[0]!.state).toBe('disposed');
  });

  test('rejects preparation against a destroyed device', () => {
    const device = new NullDevice();
    device.destroy();
    expect(() =>
      prepareMesh(device, validateMeshData(meshInput), {
        assetId: 'mesh:triangle',
        payloadVersion: 1,
        featurePolicyKey: 'policy-a',
        abiVersion: 'mesh-v1'
      })
    ).toThrow(/live RHI device/i);
  });

  test('rolls back buffers when a later upload allocation fails', () => {
    class FailingDevice extends NullDevice {
      readonly created: RHIBuffer[] = [];
      override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
        if (this.created.length === 1) throw new Error('index allocation failed');
        const buffer = super.createBuffer(descriptor);
        this.created.push(buffer);
        return buffer;
      }
    }
    const device = new FailingDevice();
    expect(() =>
      prepareMesh(device, validateMeshData(meshInput), {
        assetId: 'mesh:triangle',
        payloadVersion: 1,
        featurePolicyKey: 'policy-a',
        abiVersion: 'mesh-v1'
      })
    ).toThrow('index allocation failed');
    expect(device.created[0]?.state).toBe('disposed');
  });
});

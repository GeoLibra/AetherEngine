import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  UploadPlanner,
  disposePreparedMesh,
  prepareMeshBudgeted,
  validateMeshData,
  type MeshDataInput
} from '../../src';
import type { RHIBuffer } from '../../src/rhi/contracts';
import type { RHIBufferDescriptor } from '../../src/rhi/contracts/descriptor';

const meshInput: MeshDataInput = {
  topology: 'triangles',
  frontFace: 'ccw',
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
const variant = {
  assetId: 'mesh:triangle',
  payloadVersion: 1,
  featurePolicyKey: 'policy-a',
  abiVersion: 'mesh-v1'
};

class ObservedDevice extends NullDevice {
  readonly created: RHIBuffer[] = [];
  override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    const buffer = super.createBuffer(descriptor);
    this.created.push(buffer);
    return buffer;
  }
}

describe('budgeted mesh preparation', () => {
  test('defers the whole mesh before creating buffers when a later range exceeds the frame budget', () => {
    const device = new ObservedDevice();
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 36,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);
    const result = prepareMeshBudgeted(device, validateMeshData(meshInput), variant, planner);
    expect(result).toEqual({ status: 'deferred', reason: 'frame-byte-budget' });
    expect(device.created).toHaveLength(0);
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      liveBytes: 0
    });
  });

  test('admits both buffers, then releases reservations when preparation fails', () => {
    class FailingDevice extends ObservedDevice {
      override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
        if (this.created.length === 1) throw new Error('index allocation failed');
        return super.createBuffer(descriptor);
      }
    }
    const device = new FailingDevice();
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);
    expect(() =>
      prepareMeshBudgeted(device, validateMeshData(meshInput), variant, planner)
    ).toThrow('index allocation failed');
    expect(device.created[0]?.state).toBe('disposed');
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      liveBytes: 0
    });
  });

  test('returns the prepared variant and both live reservations for submission retirement', () => {
    const device = new ObservedDevice();
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);
    const result = prepareMeshBudgeted(device, validateMeshData(meshInput), variant, planner);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(device.created).toHaveLength(2);
    expect(result.reservations.map((entry) => entry.byteLength)).toEqual([36, 6]);
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 42,
      allocatedCommands: 2,
      liveBytes: 64
    });
    for (const reservation of result.reservations) planner.release(reservation);
    disposePreparedMesh(result.prepared.value);
  });

  test('retries a deferred mesh in a later frame without carrying partial admission', async () => {
    const device = new ObservedDevice();
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 2,
      alignment: 16
    });
    const mesh = validateMeshData(meshInput);
    planner.beginFrame(1);
    const occupying = planner.reserve(24);
    expect(occupying.status).toBe('admitted');
    if (occupying.status !== 'admitted') return;
    expect(prepareMeshBudgeted(device, mesh, variant, planner)).toEqual({
      status: 'deferred',
      reason: 'ring-capacity'
    });
    expect(device.created).toHaveLength(0);
    planner.release(occupying);
    planner.beginFrame(2);
    const result = prepareMeshBudgeted(device, mesh, variant, planner);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    const submission = device.queue.submit([]);
    for (const reservation of result.reservations) planner.retireAfter(reservation, submission);
    await submission.done;
    await Promise.resolve();
    expect(planner.snapshot().liveBytes).toBe(0);
    disposePreparedMesh(result.prepared.value);
  });
});

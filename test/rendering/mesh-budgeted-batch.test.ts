import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  UploadPlanner,
  disposePreparedMesh,
  prepareMeshBatchBudgeted,
  validateMeshData,
  type MeshDataInput
} from '../../src';
import type { RHIBuffer } from '../../src/rhi/contracts';
import type { RHIBufferDescriptor } from '../../src/rhi/contracts/descriptor';

const input: MeshDataInput = {
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
const mesh = validateMeshData(input);
const items = [0, 1].map((index) => ({
  mesh,
  variant: {
    assetId: `mesh/primitive/${index}`,
    payloadVersion: 1,
    featurePolicyKey: 'policy',
    abiVersion: 'mesh-v1'
  }
}));

class ObservedDevice extends NullDevice {
  readonly created: RHIBuffer[] = [];
  override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    const buffer = super.createBuffer(descriptor);
    this.created.push(buffer);
    return buffer;
  }
}

describe('budgeted mesh batch preparation', () => {
  test('a late frame-budget deferral creates no GPU buffers and rolls back all reservations', () => {
    const device = new ObservedDevice();
    const planner = new UploadPlanner({
      capacityBytes: 128,
      maxFrameBytes: 80,
      maxFrameCommands: 4,
      alignment: 16
    });
    planner.beginFrame(1);
    expect(prepareMeshBatchBudgeted(device, items, planner)).toEqual({
      status: 'deferred',
      reason: 'frame-byte-budget'
    });
    expect(device.created).toHaveLength(0);
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      liveBytes: 0
    });
  });

  test('prepares every primitive and returns all reservations as one admission unit', () => {
    const device = new ObservedDevice();
    const planner = new UploadPlanner({
      capacityBytes: 128,
      maxFrameBytes: 84,
      maxFrameCommands: 4,
      alignment: 16
    });
    planner.beginFrame(1);
    const result = prepareMeshBatchBudgeted(device, items, planner);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.prepared).toHaveLength(2);
    expect(result.reservations.map((entry) => entry.byteLength)).toEqual([36, 6, 36, 6]);
    expect(device.created).toHaveLength(4);
    for (const reservation of result.reservations) planner.release(reservation);
    for (const prepared of result.prepared) disposePreparedMesh(prepared.value);
  });

  test('later backend failure disposes all earlier primitive buffers and releases admission', () => {
    class FailingDevice extends ObservedDevice {
      override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
        if (this.created.length === 2) throw new Error('second primitive allocation failed');
        return super.createBuffer(descriptor);
      }
    }
    const device = new FailingDevice();
    const planner = new UploadPlanner({
      capacityBytes: 128,
      maxFrameBytes: 84,
      maxFrameCommands: 4,
      alignment: 16
    });
    planner.beginFrame(1);
    expect(() => prepareMeshBatchBudgeted(device, items, planner)).toThrow(
      'second primitive allocation failed'
    );
    expect(device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      liveBytes: 0
    });
  });
});

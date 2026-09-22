import { describe, expect, test } from 'vitest';

import { UploadPlanner } from '../../../src/rhi/core/upload-planner';
import { executeBudgetedBufferWrite } from '../../../src/rhi/core/upload-execution';
import type { RHIBuffer, RHIQueue } from '../../../src/rhi/contracts';

describe('executeBudgetedBufferWrite', () => {
  test('does not call the backend queue when frame admission defers the upload', () => {
    const planner = createPlanner(1);
    const writes: unknown[][] = [];
    const queue = { writeBuffer: (...args: unknown[]) => writes.push(args) } as unknown as RHIQueue;

    expect(
      executeBudgetedBufferWrite(planner, queue, {} as RHIBuffer, 0, new Uint8Array([1, 2]))
    ).toEqual({ status: 'deferred', reason: 'frame-command-budget' });
    expect(writes).toEqual([]);
  });

  test('rolls back the planner reservation when the backend rejects an admitted write', () => {
    const planner = createPlanner(2);
    const queue = {
      writeBuffer: () => {
        throw new Error('native upload failure');
      }
    } as unknown as RHIQueue;

    expect(() =>
      executeBudgetedBufferWrite(planner, queue, {} as RHIBuffer, 0, new Uint8Array([1, 2]))
    ).toThrow('native upload failure');
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      reservedBytes: 0,
      liveBytes: 0
    });
  });

  test('writes exactly once after admission and returns the staging reservation', () => {
    const planner = createPlanner(2);
    const writes: unknown[][] = [];
    const buffer = {} as RHIBuffer;
    const queue = { writeBuffer: (...args: unknown[]) => writes.push(args) } as unknown as RHIQueue;

    expect(
      executeBudgetedBufferWrite(planner, queue, buffer, 4, new Uint8Array([1, 2, 3]))
    ).toEqual({
      status: 'written',
      reservation: { status: 'admitted', offset: 0, byteLength: 3, size: 16 }
    });
    expect(writes).toEqual([[buffer, 4, new Uint8Array([1, 2, 3])]]);
  });
});

function createPlanner(maxFrameCommands: number): UploadPlanner {
  const planner = new UploadPlanner({
    capacityBytes: 64,
    maxFrameBytes: 64,
    maxFrameCommands,
    alignment: 16
  });
  planner.beginFrame(1);
  if (maxFrameCommands === 1) {
    planner.reserve(1);
  }
  return planner;
}

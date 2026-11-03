import { describe, expect, test } from 'vitest';

import { UploadPlanner } from '../../../src/rhi/core/upload-planner';
import { NullDevice } from '../../../src/rhi';
import type { RHISubmission } from '../../../src/rhi';

describe('UploadPlanner', () => {
  test('admits aligned staging ranges within the frame byte and command budgets', () => {
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 32,
      maxFrameCommands: 2,
      alignment: 16
    });

    planner.beginFrame(1);

    expect(planner.reserve(12)).toEqual({
      status: 'admitted',
      offset: 0,
      byteLength: 12,
      size: 16
    });
    expect(planner.reserve(12)).toEqual({
      status: 'admitted',
      offset: 16,
      byteLength: 12,
      size: 16
    });
    expect(planner.reserve(12)).toEqual({ status: 'deferred', reason: 'frame-byte-budget' });
    expect(planner.snapshot()).toEqual({
      frame: 1,
      capacityBytes: 64,
      allocatedBytes: 24,
      allocatedCommands: 2,
      reservedBytes: 32,
      liveBytes: 32,
      deferred: { 'frame-byte-budget': 1, 'frame-command-budget': 0, 'ring-capacity': 0 }
    });
  });

  test('defers a fitting upload once the frame command limit is exhausted', () => {
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 1,
      alignment: 16
    });
    planner.beginFrame(1);

    expect(planner.reserve(1)).toMatchObject({ status: 'admitted' });
    expect(planner.reserve(1)).toEqual({ status: 'deferred', reason: 'frame-command-budget' });
  });

  test('wraps only after completed submissions retire live ranges', () => {
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 4,
      alignment: 16
    });

    planner.beginFrame(1);
    expect(planner.reserve(20)).toEqual({
      status: 'admitted',
      offset: 0,
      byteLength: 20,
      size: 32
    });
    expect(planner.reserve(20)).toEqual({
      status: 'admitted',
      offset: 32,
      byteLength: 20,
      size: 32
    });

    planner.beginFrame(2);
    expect(planner.reserve(1)).toEqual({ status: 'deferred', reason: 'ring-capacity' });

    planner.retireThrough(1);
    expect(planner.reserve(20)).toEqual({
      status: 'admitted',
      offset: 0,
      byteLength: 20,
      size: 32
    });
  });

  test('rejects invalid planner configuration and invalid upload lengths at the trust boundary', () => {
    expect(
      () =>
        new UploadPlanner({
          capacityBytes: 63,
          maxFrameBytes: 64,
          maxFrameCommands: 1,
          alignment: 16
        })
    ).toThrow('capacityBytes 63 must be a multiple of alignment 16.');

    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 1,
      alignment: 16
    });
    planner.beginFrame(1);

    expect(() => planner.reserve(0)).toThrow(
      'Upload byteLength 0 must be a positive safe integer.'
    );
  });

  test('retires a successful reservation only after its submission reaches a terminal result', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);
    const reservation = planner.reserve(8);
    if (reservation.status !== 'admitted') throw new Error('Expected admitted reservation.');
    const submission = device.queue.submit([]);

    planner.retireAfter(reservation, submission);
    expect(planner.snapshot()).toMatchObject({ liveBytes: 16, allocatedBytes: 8 });
    device.queue.completeNextForTesting();
    await submission.done;
    await Promise.resolve();

    expect(planner.snapshot()).toMatchObject({ liveBytes: 0, allocatedBytes: 8 });
  });

  test('retires a reservation when the submission promise rejects', async () => {
    const planner = new UploadPlanner({
      capacityBytes: 16,
      maxFrameBytes: 16,
      maxFrameCommands: 1,
      alignment: 16
    });
    planner.beginFrame(1);
    const reservation = planner.reserve(8);
    if (reservation.status !== 'admitted') throw new Error('Expected admitted reservation.');
    let rejectSubmission!: (reason: Error) => void;
    const done = new Promise<never>((_, reject) => {
      rejectSubmission = reject;
    });
    planner.retireAfter(reservation, {
      id: 1,
      status: 'pending',
      done
    } as RHISubmission);

    rejectSubmission(new Error('device lost'));
    await expect(done).rejects.toThrow('device lost');
    await Promise.resolve();
    expect(planner.snapshot().liveBytes).toBe(0);
  });
});

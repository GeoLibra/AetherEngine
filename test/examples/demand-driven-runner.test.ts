import { describe, expect, test, vi } from 'vitest';
import { DemandDrivenRunner } from '../../examples/react-vite-ts/src/demand-driven-runner';

describe('DemandDrivenRunner', () => {
  test('advances only when explicitly requested and keeps monotonic timestamps', async () => {
    const runner = new DemandDrivenRunner();
    const frame = vi.fn((timestamp: number) => ({ frame: Math.round(timestamp * 60) + 1 }));
    const running = runner.run({ stopRequested: false, frame });

    expect(runner.frame()).toEqual({ frame: 1 });
    expect(runner.frame()).toEqual({ frame: 2 });
    expect(frame.mock.calls.map(([timestamp]) => timestamp)).toEqual([0, 1 / 60]);

    runner.requestStop('complete');
    await expect(running).resolves.toEqual({ reason: 'complete', frames: 2 });
  });

  test('fails the active run and the caller when a frame throws', async () => {
    const runner = new DemandDrivenRunner();
    const failure = new Error('frame failed');
    const running = runner.run({
      stopRequested: false,
      frame: () => {
        throw failure;
      }
    });

    expect(() => runner.frame()).toThrow(failure);
    await expect(running).rejects.toBe(failure);
  });

  test('transitions from demand mode to continuous scheduling and back', async () => {
    let nextId = 1;
    const callbacks = new Map<number, (timestamp: number) => void>();
    const host = {
      request: (cb: (timestamp: number) => void) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancel: (id: number) => {
        callbacks.delete(id);
      }
    };

    const runner = new DemandDrivenRunner(host);
    const frame = vi.fn((timestamp: number) => ({ frame: Math.round(timestamp * 60) + 1 }));
    const running = runner.run({ stopRequested: false, frame });

    // Initial demand frame
    expect(runner.frame()).toEqual({ frame: 1 });
    expect(frame).toHaveBeenCalledTimes(1);

    // Switch to continuous mode
    runner.setContinuous(true);
    expect(callbacks.size).toBe(1);

    // Trigger scheduled frame with mock timestamp
    const [firstId, firstCb] = [...callbacks.entries()][0]!;
    callbacks.delete(firstId);
    firstCb(1000);

    expect(frame).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(1);

    // Trigger second continuous frame
    const [secondId, secondCb] = [...callbacks.entries()][0]!;
    callbacks.delete(secondId);
    secondCb(1016.66);

    expect(frame).toHaveBeenCalledTimes(3);

    // Switch back to demand mode
    runner.setContinuous(false);
    expect(callbacks.size).toBe(0);

    // Explicit demand frame still works
    expect(runner.frame()).toEqual({ frame: expect.any(Number) });
    expect(frame).toHaveBeenCalledTimes(4);

    runner.requestStop('complete');
    await expect(running).resolves.toEqual({
      reason: 'complete',
      frames: 4
    });
  });
});

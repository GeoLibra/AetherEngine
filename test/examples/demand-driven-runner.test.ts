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
});

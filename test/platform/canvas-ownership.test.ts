import { describe, expect, test } from 'vitest';
import { CanvasOwnershipRegistry } from '../../src/platform/browser/canvas-ownership';

describe('CanvasOwnershipRegistry', () => {
  test('acquires an exclusive lease on an available canvas', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');

    const lease = registry.acquire(canvas, session1);
    expect(lease.sessionId).toBe(session1);
    expect(lease.canvas).toBe(canvas);
    expect(lease.isCurrent()).toBe(true);
  });

  test('throws canvas-ownership-conflict when another active session attempts to acquire', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');
    const session2 = Symbol('session-2');

    registry.acquire(canvas, session1);

    expect(() => registry.acquire(canvas, session2)).toThrowError(
      '[canvas-ownership-conflict] Canvas is already owned by an active graphics session.'
    );
  });

  test('rejects duplicate acquisition even by the same session identity', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');

    const lease1 = registry.acquire(canvas, session1);
    expect(lease1.isCurrent()).toBe(true);

    expect(() => registry.acquire(canvas, session1)).toThrowError(
      '[canvas-ownership-conflict] Canvas is already owned by an active graphics session.'
    );
  });

  test('guarantees that an outdated lease from the same session identity cannot release or invalidate a subsequent lease', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');

    const leaseA = registry.acquire(canvas, session1);
    leaseA.release();

    const leaseB = registry.acquire(canvas, session1);
    expect(leaseB.isCurrent()).toBe(true);

    // Stale release from leaseA must never delete leaseB's active ownership
    leaseA.release();
    expect(leaseB.isCurrent()).toBe(true);

    leaseB.release();
    expect(leaseB.isCurrent()).toBe(false);
  });

  test('frees the canvas upon lease release so subsequent sessions can acquire it', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');
    const session2 = Symbol('session-2');

    const lease1 = registry.acquire(canvas, session1);
    expect(lease1.isCurrent()).toBe(true);

    lease1.release();
    expect(lease1.isCurrent()).toBe(false);

    const lease2 = registry.acquire(canvas, session2);
    expect(lease2.sessionId).toBe(session2);
    expect(lease2.isCurrent()).toBe(true);
  });

  test('handles idempotent release without corrupting subsequent leases', () => {
    const registry = new CanvasOwnershipRegistry();
    const canvas = {} as HTMLCanvasElement;
    const session1 = Symbol('session-1');
    const session2 = Symbol('session-2');

    const lease1 = registry.acquire(canvas, session1);
    lease1.release();
    lease1.release(); // Redundant release

    const lease2 = registry.acquire(canvas, session2);
    expect(lease2.isCurrent()).toBe(true);

    lease1.release(); // Stale release attempt from previous lease
    expect(lease2.isCurrent()).toBe(true); // Must not corrupt lease2
  });
});

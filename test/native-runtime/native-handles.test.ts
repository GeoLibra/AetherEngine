import { describe, expect, test } from 'vitest';

import {
  NativeHandleRegistry,
  NativeTransferCapabilityError,
  createNativeTransfer,
  type NativeArrayBufferCapabilities,
  type NativeTransferPort
} from '../../src';

interface NativeValue {
  readonly kind: 'buffer' | 'texture';
  readonly label: string;
}

const ALL_CAPABILITIES: NativeArrayBufferCapabilities = Object.freeze({
  transfer: true,
  mapped: true,
  shared: true
});

describe('NativeHandleRegistry', () => {
  test('checks owner, generation, and expected type before resolving', () => {
    const registry = new NativeHandleRegistry<NativeValue>({
      owner: 'device-a',
      destroy: () => undefined
    });
    const handle = registry.create('buffer', { kind: 'buffer', label: 'vertices' });

    expect(registry.resolve(handle, 'buffer')).toEqual({ kind: 'buffer', label: 'vertices' });
    expect(() => registry.resolve({ ...handle, owner: 'device-b' }, 'buffer')).toThrow(/owner/i);
    expect(() => registry.release({ ...handle, owner: 'device-b' })).toThrow(/owner/i);
    expect(() =>
      registry.resolve({ ...handle, generation: handle.generation + 1 }, 'buffer')
    ).toThrow(/generation/i);
    expect(() => registry.resolve(handle, 'texture')).toThrow(/type/i);
  });

  test('logical release is exactly once for explicit disposal and finalization', () => {
    const destroyed: string[] = [];
    const registry = new NativeHandleRegistry<NativeValue>({
      owner: 'device-a',
      destroy: (value) => destroyed.push(value.label)
    });
    const explicit = registry.create('buffer', { kind: 'buffer', label: 'explicit' });
    const finalized = registry.create('texture', { kind: 'texture', label: 'finalized' });

    expect(registry.release(explicit)).toBe(true);
    expect(registry.release(explicit)).toBe(false);
    expect(registry.finalize(explicit)).toBe(false);
    expect(registry.finalize(finalized)).toBe(true);
    expect(registry.finalize(finalized)).toBe(false);
    expect(destroyed).toEqual(['explicit', 'finalized']);
    expect(registry.liveEntries).toBe(0);
  });

  test('defers native destruction until every in-flight lease is released', () => {
    const destroyed: string[] = [];
    const registry = new NativeHandleRegistry<NativeValue>({
      owner: 'device-a',
      destroy: (value) => destroyed.push(value.label)
    });
    const handle = registry.create('buffer', { kind: 'buffer', label: 'leased' });
    const first = registry.lease(handle, 'buffer');
    const second = registry.lease(handle, 'buffer');

    expect(registry.release(handle)).toBe(true);
    expect(destroyed).toEqual([]);
    expect(() => registry.resolve(handle, 'buffer')).toThrow(/released|stale/i);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(destroyed).toEqual([]);
    expect(second.release()).toBe(true);
    expect(second.release()).toBe(false);
    expect(destroyed).toEqual(['leased']);
    expect(registry.liveEntries).toBe(0);
  });

  test('generation loss stales old handles while allowing late lease cleanup', () => {
    const destroyed: string[] = [];
    const registry = new NativeHandleRegistry<NativeValue>({
      owner: 'device-a',
      destroy: (value) => destroyed.push(value.label)
    });
    const old = registry.create('buffer', { kind: 'buffer', label: 'old' });
    const lease = registry.lease(old, 'buffer');

    registry.loseGeneration();
    expect(() => registry.resolve(old, 'buffer')).toThrow(/generation|stale/i);
    const current = registry.create('buffer', { kind: 'buffer', label: 'current' });
    expect(current.generation).toBe(old.generation + 1);
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(destroyed).toEqual(['old']);
    expect(registry.release(current)).toBe(true);
    expect(registry.liveEntries).toBe(0);
  });
});

class TransferPort implements NativeTransferPort {
  readonly owner = 'native-runtime';
  readonly releases: Array<{ id: number; reason: 'settled' | 'cancelled' }> = [];
  private nextId = 1;

  constructor(readonly capabilities: NativeArrayBufferCapabilities = ALL_CAPABILITIES) {}

  allocateId(): number {
    return this.nextId++;
  }

  takeOwnership(data: ArrayBuffer): ArrayBuffer {
    return structuredClone(data, { transfer: [data] });
  }

  release(id: number, reason: 'settled' | 'cancelled'): void {
    this.releases.push({ id, reason });
  }
}

describe('native ArrayBuffer transfer leases', () => {
  test('copy mode isolates bytes and exposes no retainable backing pointer', () => {
    const source = new Uint8Array([1, 2, 3]);
    const lease = createNativeTransfer(source.buffer, 'copy', new TransferPort());
    const view = lease.view;

    source[0] = 9;
    expect(view.copyBytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(view.read(1)).toBe(2);
    lease.settle();
    expect(() => view.read(0)).toThrow(/settled|inactive/i);
    expect(() => lease.view).toThrow(/settled|inactive/i);
  });

  test.each([
    ['transfer', { transfer: false, mapped: true, shared: true }],
    ['mapped', { transfer: true, mapped: false, shared: true }],
    ['shared', { transfer: true, mapped: true, shared: false }]
  ] as const)('gates %s mode on handshake capabilities', (mode, capabilities) => {
    let error: unknown;
    try {
      createNativeTransfer(new ArrayBuffer(1), mode, new TransferPort(capabilities));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NativeTransferCapabilityError);
    expect(error).toMatchObject({ mode });
  });

  test('makes transfer ownership explicit and finalizes exactly once', () => {
    const port = new TransferPort();
    const source = new Uint8Array([4, 5]);
    const lease = createNativeTransfer(source.buffer, 'transfer', port);

    expect(lease.owner).toBe('native-runtime');
    expect(source.byteLength).toBe(0);
    expect(lease.view.copyBytes()).toEqual(new Uint8Array([4, 5]));
    expect(lease.state).toBe('active');
    expect(lease.settle()).toBe(true);
    expect(lease.settle()).toBe(false);
    expect(lease.cancel()).toBe(false);
    expect(lease.finalize()).toBe(false);
    expect(port.releases).toEqual([{ id: lease.id, reason: 'settled' }]);
  });

  test('cancellation is terminal and drops access to transferred bytes', () => {
    const port = new TransferPort();
    const lease = createNativeTransfer(new Uint8Array([7]).buffer, 'mapped', port);
    const view = lease.view;

    expect(lease.cancel()).toBe(true);
    expect(lease.state).toBe('cancelled');
    expect(lease.cancel()).toBe(false);
    expect(() => view.copyBytes()).toThrow(/cancelled|inactive/i);
    expect(port.releases).toEqual([{ id: lease.id, reason: 'cancelled' }]);
  });

  test('finalizer releases an abandoned active transfer exactly once', () => {
    const port = new TransferPort();
    const lease = createNativeTransfer(new ArrayBuffer(2), 'shared', port);

    expect(lease.finalize()).toBe(true);
    expect(lease.finalize()).toBe(false);
    expect(port.releases).toEqual([{ id: lease.id, reason: 'cancelled' }]);
  });
});

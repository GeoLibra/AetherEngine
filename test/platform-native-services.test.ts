import { describe, expect, test } from 'vitest';

import {
  NativeFilesystemServiceToken,
  NativeSensorsServiceToken,
  MutablePlatformServiceRegistry,
  createNativeFilesystemService,
  createNativeSensorService,
  defineNativeServiceModule,
  normalizeNativeMountUri,
  registerNativeServiceModules,
  type NativeFilesystemPort,
  type NativeNegotiatedHandshake,
  type NativeSensorEvent,
  type NativeSensorPort
} from '../src';

const handshake = (modules: readonly { name: string; version: number }[]): NativeNegotiatedHandshake => ({
  buildId: 'test', engineAbiVersion: 1, rhiContractVersion: 1, modules,
  abi: { endianness: 'little', pointerBits: 64, arrayBuffer: { transfer: true, mapped: false, shared: false } }
});

describe('native platform service modules', () => {
  test('admits negotiated versions, rejects mismatches and duplicate registration', () => {
    const registry = new MutablePlatformServiceRegistry();
    const module = defineNativeServiceModule({
      name: 'filesystem', version: 2, required: true,
      token: NativeFilesystemServiceToken,
      create: () => createNativeFilesystemService({
        canRead: () => true,
        read: async () => new Uint8Array()
      })
    });

    expect(registerNativeServiceModules(registry, handshake([{ name: 'filesystem', version: 2 }]), [module]))
      .toEqual([]);
    expect(() => registerNativeServiceModules(registry, handshake([{ name: 'filesystem', version: 2 }]), [module]))
      .toThrow(/already registered/i);
    expect(() => registerNativeServiceModules(
      new MutablePlatformServiceRegistry(), handshake([{ name: 'filesystem', version: 1 }]), [module]
    )).toThrow(/version/i);
  });

  test('returns immutable diagnostics for unavailable optional modules', () => {
    const optional = defineNativeServiceModule({
      name: 'sensors', version: 1, required: false,
      token: NativeSensorsServiceToken,
      create: () => createNativeSensorService({ subscribe: () => () => undefined })
    });
    const diagnostics = registerNativeServiceModules(
      new MutablePlatformServiceRegistry(), handshake([]), [optional]
    );

    expect(diagnostics).toEqual([{
      kind: 'optional-module-unavailable', module: 'sensors', requiredVersion: 1,
      actualVersion: undefined
    }]);
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(diagnostics.every(Object.isFrozen)).toBe(true);
  });
});

describe('native filesystem service', () => {
  test('normalizes mount URIs and rejects traversal, paths, queries, and user paths', () => {
    expect(normalizeNativeMountUri('assets://textures//ui/button.bin')).toBe('assets://textures/ui/button.bin');
    for (const unsafe of [
      'assets://../secret', '/Users/person/secret', 'C:\\Users\\person\\secret',
      'assets://%2e%2e/secret', 'assets://file?token=secret', 'assets://file#private'
    ]) {
      expect(() => normalizeNativeMountUri(unsafe)).toThrow('Native filesystem URI is invalid.');
    }
  });

  test('checks mount permissions, copies bytes, and redacts rejected URI details', async () => {
    const backing = new Uint8Array([1, 2, 3]);
    const calls: string[] = [];
    const port: NativeFilesystemPort = {
      canRead: (mount) => mount === 'assets',
      read: async (uri) => { calls.push(uri); return backing; }
    };
    const service = createNativeFilesystemService(port);
    const bytes = await service.read('assets://data.bin');
    backing[0] = 9;

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(calls).toEqual(['assets://data.bin']);
    await expect(service.read('private://secret.txt')).rejects.toThrow('Native filesystem permission denied.');
    await service.read('/Users/person/private?token=secret').catch((error: unknown) => {
      expect(String(error)).not.toContain('person');
      expect(String(error)).not.toContain('token');
    });

    const failing = createNativeFilesystemService({
      canRead: () => true,
      read: async () => { throw new Error('/Users/person/private?token=secret'); }
    });
    await failing.read('assets://safe.bin').catch((error: unknown) => {
      expect(String(error)).toBe('Error: Native filesystem read failed.');
    });
  });
});

describe('native sensor service', () => {
  test('publishes immutable event copies and cleans subscriptions exactly once', () => {
    let listener: ((event: NativeSensorEvent) => void) | undefined;
    let cleanups = 0;
    const port: NativeSensorPort = {
      subscribe(_kind, next) {
        listener = next;
        return () => { cleanups += 1; listener = undefined; };
      }
    };
    const service = createNativeSensorService(port);
    const received: NativeSensorEvent[] = [];
    const unsubscribe = service.subscribe('accelerometer', (event) => received.push(event));
    const values = [1, 2, 3];
    listener?.({ timestamp: 1, values });
    values[0] = 9;

    expect(received).toEqual([{ timestamp: 1, values: [1, 2, 3] }]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen(received[0]!.values)).toBe(true);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
    expect(cleanups).toBe(1);
  });
});

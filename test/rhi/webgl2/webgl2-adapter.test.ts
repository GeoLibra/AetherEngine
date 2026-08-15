import { describe, expect, test } from 'vitest';

import * as RHI from '../../../src';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function formatCapabilities() {
  return {
    sample: true,
    filter: true,
    render: true,
    blend: false,
    storage: false,
    copySrc: true,
    copyDst: true,
    sampleCounts: [1, 4]
  };
}

class NativeContext {
  readonly info = { name: 'Fake WebGL2', vendor: 'Mesa', renderer: 'llvmpipe' };
  readonly extensions = new Set(['EXT_disjoint_timer_query_webgl2']);
  readonly limits = { maxTextureUnits: 16, uniformBufferOffsetAlignment: 256 };
  readonly formats = new Map([['rgba8unorm', formatCapabilities()]]);
  readonly precision = { fragmentHighFloatBits: 23 };
  private readonly loss = deferred<{ reason?: string; message?: string }>();
  readonly lost = this.loss.promise;
  destroyed = 0;
  readonly clipControlCalls: Array<readonly [string, string]> = [];

  lose(reason = 'context-lost', message = 'context reset'): void {
    this.loss.resolve({ reason, message });
  }

  destroy(): void {
    this.destroyed += 1;
  }
  setClipControl(origin: 'lower-left', depth: 'zero-to-one'): void {
    this.clipControlCalls.push([origin, depth]);
  }
}

function adapterConstructor() {
  const Adapter = (RHI as unknown as Record<string, unknown>).WebGL2Adapter;
  expect(Adapter).toBeTypeOf('function');
  return Adapter as new (native: NativeContext) => {
    readonly info: Readonly<Record<string, unknown>>;
    readonly capabilities: {
      readonly backend: string;
      readonly features: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
      readonly limits: Readonly<Record<string, number | undefined>>;
      readonly formats: ReadonlyMap<string, ReturnType<typeof formatCapabilities>>;
      readonly queues: readonly Readonly<Record<string, unknown>>[];
    };
    readonly facts: {
      readonly extensions: ReadonlySet<string>;
      readonly precision: Readonly<Record<string, number>>;
      readonly clipDepthMode: string;
    };
    requestDevice(request: {
      requiredFeatures: readonly string[];
      optionalFeatures: readonly string[];
      requiredLimits?: Readonly<Record<string, number>>;
    }): Promise<{
      readonly capabilities: { readonly backend: string };
      readonly generation: number;
      readonly state: string;
      readonly lost: Promise<{ reason: string; message: string; generation: number }>;
      destroy(): void;
    }>;
  };
}

describe('WebGL2 adapter capability negotiation', () => {
  test('seals the read-only extension set without exposing its copied backing set', () => {
    const native = new NativeContext();
    const adapter = new (adapterConstructor())(native);
    const extensions = adapter.facts.extensions;

    expect(Object.isFrozen(extensions)).toBe(true);
    expect(() => Object.assign(extensions, { debugState: true })).toThrow();
    expect(() => Object.assign(extensions, { size: 999 })).toThrow();
    expect(Reflect.ownKeys(extensions)).toEqual([]);
    expect(Object.values(extensions).some((value) => value instanceof Set)).toBe(false);
    expect(extensions.has('EXT_disjoint_timer_query_webgl2')).toBe(true);
    expect([...extensions]).toEqual(['EXT_disjoint_timer_query_webgl2']);
  });

  test('snapshots probed limits, formats, extensions, precision, and one graphics queue', () => {
    const native = new NativeContext();
    const adapter = new (adapterConstructor())(native);

    expect(adapter.info).toEqual({
      name: 'Fake WebGL2',
      backend: 'webgl2',
      vendor: 'Mesa',
      architecture: 'llvmpipe'
    });
    expect(adapter.capabilities.backend).toBe('webgl2');
    expect(adapter.capabilities.features.get('compute')?.status).toBe('unsupported');
    expect(adapter.capabilities.features.get('timestamp-query')?.status).toBe('native');
    expect(adapter.capabilities.queues).toEqual([{ role: 'graphics', status: 'native' }]);
    expect(adapter.capabilities.limits.uniformBufferOffsetAlignment).toBe(256);
    expect(adapter.capabilities.formats.get('rgba8unorm')?.sampleCounts).toEqual([1, 4]);
    expect(adapter.facts.precision).toEqual({ fragmentHighFloatBits: 23 });
    expect(adapter.facts.clipDepthMode).toBe('vertex-remap');
    expect([...adapter.facts.extensions]).toEqual(['EXT_disjoint_timer_query_webgl2']);
    expect(Object.keys(adapter.facts.extensions)).toEqual([]);
    expect(Object.getOwnPropertyNames(adapter.facts.extensions)).toEqual([]);
    expect('valuesSet' in adapter.facts.extensions).toBe(false);
    expect(
      (adapter.facts.extensions as unknown as { valuesSet?: Set<string> }).valuesSet
    ).toBeUndefined();
    expect('add' in adapter.facts.extensions).toBe(false);

    native.limits.uniformBufferOffsetAlignment = 4;
    native.formats.get('rgba8unorm')?.sampleCounts.splice(0, 2, 8);
    native.extensions.clear();
    (native.precision as Record<string, number | object>).nestedExtra = { callerOwned: true };
    expect(adapter.capabilities.limits.uniformBufferOffsetAlignment).toBe(256);
    expect(adapter.capabilities.formats.get('rgba8unorm')?.sampleCounts).toEqual([1, 4]);
    expect([...adapter.facts.extensions]).toEqual(['EXT_disjoint_timer_query_webgl2']);
    expect('nestedExtra' in adapter.facts.precision).toBe(false);
  });

  test('selects zero-to-one clip depth and initializes EXT_clip_control per device', async () => {
    const native = new NativeContext();
    native.extensions.add('EXT_clip_control');
    const adapter = new (adapterConstructor())(native);

    expect(adapter.facts.clipDepthMode).toBe('zero-to-one');
    await adapter.requestDevice({ requiredFeatures: [], optionalFeatures: [] });
    expect(native.clipControlCalls).toEqual([['lower-left', 'zero-to-one']]);
  });

  test('rejects unsupported required features and insufficient required limits', async () => {
    const adapter = new (adapterConstructor())(new NativeContext());

    await expect(
      adapter.requestDevice({
        requiredFeatures: ['compute'],
        optionalFeatures: [],
        requiredLimits: { maxTextureUnits: 32 }
      })
    ).rejects.toMatchObject({
      name: 'RHIDeviceRequestError',
      missing: [
        { kind: 'feature', feature: 'compute' },
        { kind: 'limit', limit: 'maxTextureUnits', minimum: 32, actual: 16 }
      ]
    });
  });

  test('creates generation-bound devices and maps native context loss once', async () => {
    const native = new NativeContext();
    const adapter = new (adapterConstructor())(native);
    const device = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query'],
      optionalFeatures: ['compute']
    });

    expect(device.capabilities.backend).toBe('webgl2');
    expect(device.state).toBe('live');
    expect(device.generation).toBeGreaterThan(0);

    native.lose('context-lost', 'browser reset');
    await expect(device.lost).resolves.toEqual({
      reason: 'context-lost',
      message: 'browser reset',
      generation: device.generation
    });
    expect(device.state).toBe('lost');

    device.destroy();
    device.destroy();
    expect(native.destroyed).toBe(1);
  });
});

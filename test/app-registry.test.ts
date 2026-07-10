import { describe, expect, test } from 'vitest';
import {
  ExtensionRegistry,
  ServiceRegistry,
  createExtensionPoint,
  createServiceToken,
  serviceFactory,
  serviceValue
} from '../src';

describe('ServiceRegistry', () => {
  test('distinguishes function values from factories and detects factory cycles', () => {
    const FunctionToken = createServiceToken<() => string>('function');
    const A = createServiceToken<object>('a');
    const B = createServiceToken<object>('b');
    const registry = new ServiceRegistry();

    registry.provide(FunctionToken, serviceValue(() => 'value'));
    registry.provide(A, serviceFactory((services) => services.get(B)));
    registry.provide(B, serviceFactory((services) => services.get(A)));

    expect(registry.get(FunctionToken)()).toBe('value');
    expect(() => registry.get(A)).toThrow('a -> b -> a');
  });

  test('uses only explicit scope parents', () => {
    const Token = createServiceToken<string>('scoped');
    const registry = new ServiceRegistry();
    registry.provide(Token, serviceValue('global', { scope: 'global' }));

    expect(registry.get(Token, 'render')).toBe('global');
    expect(registry.get(Token, 'main')).toBe('global');
  });

  test('rejects duplicates and restores a pre-resolution replacement', () => {
    const Token = createServiceToken<string>('replaceable');
    const registry = new ServiceRegistry();
    registry.provide(Token, serviceValue('original'));

    expect(() => registry.provide(Token, serviceValue('duplicate'))).toThrow(
      'Service "replaceable" is already registered in scope "main".'
    );

    const replacement = registry.replace(Token, serviceValue('replacement'));
    expect(replacement.remove()).toBe(true);
    expect(replacement.remove()).toBe(false);
    expect(registry.get(Token)).toBe('original');
    expect(() => registry.replace(Token, serviceValue('late'))).toThrow(
      'Service "replaceable" in scope "main" has already been resolved.'
    );
  });

  test('disposes frame services synchronously even when later disposal fails', () => {
    const events: string[] = [];
    const First = createServiceToken<object>('first');
    const Second = createServiceToken<object>('second');
    const registry = new ServiceRegistry();
    registry.provide(
      First,
      serviceFactory(() => ({}), {
        lifecycle: 'frame',
        dispose: () => {
          events.push('first');
          throw new Error('first failed');
        }
      })
    );
    registry.provide(
      Second,
      serviceFactory(() => ({}), {
        lifecycle: 'frame',
        dispose: () => void events.push('second')
      })
    );
    const firstFrameValue = registry.get(First);
    registry.get(Second);

    const errors = registry.clearFrameScoped();

    expect(events).toEqual(['first', 'second']);
    expect(errors).toHaveLength(1);
    expect(registry.get(First)).not.toBe(firstFrameValue);
  });

  test('disposes singleton caches but leaves transient values caller-owned', async () => {
    const events: string[] = [];
    const Singleton = createServiceToken<object>('singleton');
    const Transient = createServiceToken<object>('transient');
    const registry = new ServiceRegistry();
    registry.provide(
      Singleton,
      serviceFactory(() => ({}), {
        dispose: async () => void events.push('singleton')
      })
    );
    registry.provide(
      Transient,
      serviceFactory(() => ({}), {
        lifecycle: 'transient',
        dispose: () => void events.push('transient')
      })
    );
    registry.get(Singleton);
    registry.get(Transient);

    expect(await registry.disposeAll()).toEqual([]);
    expect(events).toEqual(['singleton']);
  });
});

describe('ExtensionRegistry', () => {
  test('orders frozen snapshots by priority then registration order', () => {
    const Point = createExtensionPoint<string>('point');
    const registry = new ExtensionRegistry();
    registry.add(Point, 'plugin.low', { id: 'low', priority: 0, value: 'low' });
    registry.add(Point, 'plugin.first', { id: 'first', priority: 10, value: 'first' });
    registry.add(Point, 'plugin.second', { id: 'second', priority: 10, value: 'second' });

    const snapshot = registry.list(Point);

    expect(snapshot.map((entry) => entry.value)).toEqual(['first', 'second', 'low']);
    expect(snapshot.map((entry) => entry.ownerPlugin)).toEqual([
      'plugin.first',
      'plugin.second',
      'plugin.low'
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(() => registry.add(Point, 'plugin.duplicate', { id: 'low', value: 'duplicate' })).toThrow(
      'duplicate extension contribution "low"'
    );
  });

  test('supports exact removal and owner cleanup without mutating old snapshots', () => {
    const Point = createExtensionPoint<string>('owned');
    const registry = new ExtensionRegistry();
    const first = registry.add(Point, 'plugin.first', { id: 'first', value: 'first' });
    registry.add(Point, 'plugin.second', { id: 'second', value: 'second' });
    const snapshot = registry.list(Point);

    expect(first.remove()).toBe(true);
    expect(first.remove()).toBe(false);
    registry.removeOwner('plugin.second');

    expect(registry.list(Point)).toEqual([]);
    expect(snapshot.map((entry) => entry.value)).toEqual(['first', 'second']);
  });
});

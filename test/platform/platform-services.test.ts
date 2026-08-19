import { describe, expect, test } from 'vitest';
import { MutablePlatformServiceRegistry, createPlatformServiceToken } from '../../src';

describe('Platform services', () => {
  test('preserve typed lookup and reject duplicate registration', () => {
    const Clipboard = createPlatformServiceToken<{ read(): string }>('clipboard');
    const registry = new MutablePlatformServiceRegistry();

    registry.provide(Clipboard, { read: () => 'text' });

    expect(registry.get(Clipboard).read()).toBe('text');
    expect(registry.tryGet(Clipboard)?.read()).toBe('text');
    expect(() => registry.provide(Clipboard, { read: () => 'other' })).toThrow(
      'Platform service "clipboard" is already registered.'
    );
  });

  test('return immutable deterministic registration snapshots', () => {
    const Clipboard = createPlatformServiceToken<object>('clipboard');
    const Fullscreen = createPlatformServiceToken<object>('fullscreen');
    const registry = new MutablePlatformServiceRegistry();
    registry.provide(Clipboard, {});
    registry.provide(Fullscreen, {});

    const entries = registry.list();

    expect(entries.map((entry) => entry.name)).toEqual(['clipboard', 'fullscreen']);
    expect(entries.map((entry) => entry.token)).toEqual([Clipboard, Fullscreen]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
  });

  test('make missing required services explicit', () => {
    const PointerLock = createPlatformServiceToken<object>('pointer-lock');
    const registry = new MutablePlatformServiceRegistry();

    expect(registry.tryGet(PointerLock)).toBeUndefined();
    expect(() => registry.get(PointerLock)).toThrow(
      'Platform service "pointer-lock" is not registered.'
    );
  });
});

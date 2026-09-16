import { describe, expect, test } from 'vitest';
import { App, DefaultPlugins, MinimalPlugins, PluginGroupBuilder, definePlugin } from '../../src';

describe('PluginGroup and PluginGroupBuilder', () => {
  const pluginA = definePlugin({ id: 'plugin-a', build: () => undefined });
  const pluginB = definePlugin({ id: 'plugin-b', build: () => undefined });
  const pluginC = definePlugin({
    id: 'plugin-c',
    dependencies: ['plugin-a'],
    build: () => undefined
  });

  test('creates an immutable group of plugins', () => {
    const group = new PluginGroupBuilder([pluginA, pluginB]);
    expect(group.plugins().map((p) => p.id)).toEqual(['plugin-a', 'plugin-b']);
  });

  test('replaces an existing plugin at the exact same index with set()', () => {
    const replacementA = definePlugin({ id: 'plugin-a', build: () => undefined });
    const group = new PluginGroupBuilder([pluginA, pluginB]);
    const updated = group.set(replacementA);

    expect(updated).not.toBe(group);
    expect(updated.plugins()[0]).toBe(replacementA);
    expect(updated.plugins()[1]).toBe(pluginB);
    // Original unchanged
    expect(group.plugins()[0]).toBe(pluginA);
  });

  test('fails set() when attempting to replace an unknown plugin', () => {
    const unknown = definePlugin({ id: 'unknown-plugin', build: () => undefined });
    const group = new PluginGroupBuilder([pluginA]);

    expect(() => group.set(unknown)).toThrow('Cannot replace unknown plugin "unknown-plugin"');
  });

  test('disables and enables declared plugins immutably', () => {
    const group = new PluginGroupBuilder([pluginA, pluginB]);
    const disabled = group.disable('plugin-a');

    expect(disabled).not.toBe(group);
    expect(disabled.plugins().map((p) => p.id)).toEqual(['plugin-b']);
    expect(group.plugins().map((p) => p.id)).toEqual(['plugin-a', 'plugin-b']);

    const reEnabled = disabled.enable('plugin-a');
    expect(reEnabled.plugins().map((p) => p.id)).toEqual(['plugin-a', 'plugin-b']);
  });

  test('fails disable() and enable() on undeclared plugins', () => {
    const group = new PluginGroupBuilder([pluginA]);
    expect(() => group.disable('undeclared')).toThrow('Cannot disable undeclared plugin');
    expect(() => group.enable('undeclared')).toThrow('Cannot enable undeclared plugin');
  });

  test('disabling a required dependency fails App startup preflight', async () => {
    const group = new PluginGroupBuilder([pluginA, pluginC]);
    const brokenGroup = group.disable('plugin-a');

    const app = new App().addPlugins(brokenGroup);
    await expect(app.startup()).rejects.toThrow(
      'Plugin dependency is missing: plugin-c -> plugin-a'
    );
  });

  test('MinimalPlugins and DefaultPlugins provide TimePlugin and extend PluginGroupBuilder', () => {
    const minimal = new MinimalPlugins();
    expect(minimal.plugins().map((p) => p.id)).toEqual(['aether.time']);

    const defaults = new DefaultPlugins();
    expect(defaults.plugins().map((p) => p.id)).toEqual(['aether.time']);

    const customTime = definePlugin({ id: 'aether.time', build: () => undefined });
    const modifiedDefaults = defaults.set(customTime);
    expect(modifiedDefaults.plugins()[0]).toBe(customTime);
  });
});

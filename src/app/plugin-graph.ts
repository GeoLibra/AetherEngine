import type { Plugin } from './types';

/** Validates the complete plugin set and returns a stable dependency order. */
export function sortPlugins(plugins: readonly Plugin[]): readonly Plugin[] {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    if (plugin.id.trim() === '') {
      throw new Error('Plugin id must not be empty.');
    }
    if (byId.has(plugin.id)) {
      throw new Error(`duplicate plugin id "${plugin.id}"`);
    }
    byId.set(plugin.id, plugin);
  }

  for (const plugin of plugins) {
    for (const dependency of plugin.dependencies ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(`Plugin dependency is missing: ${plugin.id} -> ${dependency}.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const ordered: Plugin[] = [];

  const visit = (plugin: Plugin): void => {
    if (visited.has(plugin.id)) {
      return;
    }
    if (visiting.has(plugin.id)) {
      const start = path.indexOf(plugin.id);
      const cycle = [...path.slice(start), plugin.id];
      throw new Error(`Plugin dependency cycle: ${cycle.join(' -> ')}.`);
    }

    visiting.add(plugin.id);
    path.push(plugin.id);
    for (const dependencyId of plugin.dependencies ?? []) {
      visit(byId.get(dependencyId) as Plugin);
    }
    path.pop();
    visiting.delete(plugin.id);
    visited.add(plugin.id);
    ordered.push(plugin);
  };

  for (const plugin of plugins) {
    visit(plugin);
  }
  return Object.freeze(ordered);
}

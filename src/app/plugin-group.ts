import type { Plugin, PluginGroup } from './types';

/**
 * Immutable startup composition builder for configuring plugin groups.
 * Supports replacing members, enabling, and disabling declared plugins before registration.
 */
export class PluginGroupBuilder implements PluginGroup {
  private readonly entries: readonly Plugin[];
  private readonly disabledIds: ReadonlySet<string>;

  constructor(
    plugins: readonly Plugin[] = [],
    disabledIds: ReadonlySet<string> = new Set<string>()
  ) {
    this.entries = Object.freeze([...plugins]);
    this.disabledIds = new Set(disabledIds);
  }

  /**
   * Replaces an existing group member by stable ID at the exact same position.
   * Throws if the plugin ID is unknown in this group.
   */
  set(plugin: Plugin): PluginGroupBuilder {
    const index = this.entries.findIndex((p) => p.id === plugin.id);
    if (index < 0) {
      throw new Error(`Cannot replace unknown plugin "${plugin.id}" in PluginGroup.`);
    }
    const next = [...this.entries];
    next[index] = plugin;
    return new PluginGroupBuilder(next, this.disabledIds);
  }

  /**
   * Disables a declared group member so it is omitted from App registration.
   * Throws if the plugin ID is not declared in this group.
   */
  disable(id: string): PluginGroupBuilder {
    if (!this.entries.some((p) => p.id === id)) {
      throw new Error(`Cannot disable undeclared plugin "${id}" in PluginGroup.`);
    }
    const nextDisabled = new Set(this.disabledIds);
    nextDisabled.add(id);
    return new PluginGroupBuilder(this.entries, nextDisabled);
  }

  /**
   * Enables a previously disabled declared group member.
   * Throws if the plugin ID is not declared in this group.
   */
  enable(id: string): PluginGroupBuilder {
    if (!this.entries.some((p) => p.id === id)) {
      throw new Error(`Cannot enable undeclared plugin "${id}" in PluginGroup.`);
    }
    const nextDisabled = new Set(this.disabledIds);
    nextDisabled.delete(id);
    return new PluginGroupBuilder(this.entries, nextDisabled);
  }

  /** Materializes the active, enabled plugins as an immutable list. */
  plugins(): readonly Plugin[] {
    return Object.freeze(this.entries.filter((p) => !this.disabledIds.has(p.id)));
  }

  /** Returns this immutable builder as a PluginGroup. */
  build(): PluginGroup {
    return this;
  }
}

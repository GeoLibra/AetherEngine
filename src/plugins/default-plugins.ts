import { PluginGroupBuilder } from '../app/plugin-group';
import { TimePlugin } from './time-plugin';

/**
 * Minimal determinism profile providing frame, fixed-step, and diagnostic time resources.
 * Contains only TimePlugin.
 */
export class MinimalPlugins extends PluginGroupBuilder {
  constructor() {
    super([TimePlugin]);
  }
}

/**
 * Standard default plugins profile.
 * Extensible via PluginGroupBuilder methods: set(), enable(), disable().
 */
export class DefaultPlugins extends PluginGroupBuilder {
  constructor() {
    super([TimePlugin]);
  }
}

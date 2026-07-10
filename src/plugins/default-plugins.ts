import type { Plugin, PluginGroup } from '../app/plugin';
import { TimePlugin } from './time-plugin';

export class MinimalPlugins implements PluginGroup {
  plugins(): readonly Plugin[] {
    return Object.freeze([TimePlugin]);
  }
}

export class DefaultPlugins implements PluginGroup {
  plugins(): readonly Plugin[] {
    return Object.freeze([TimePlugin]);
  }
}

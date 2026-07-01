import type { Plugin, PluginGroup } from '../app/plugin';
import { TimePlugin } from './time-plugin';

export class MinimalPlugins implements PluginGroup {
  plugins(): Plugin[] {
    return [TimePlugin];
  }
}

export class DefaultPlugins implements PluginGroup {
  plugins(): Plugin[] {
    return [TimePlugin];
  }
}

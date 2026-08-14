import type { DynamicPluginId, PluginActivationId, PluginVersionId } from './types';

export function dynamicPluginId(value: string): DynamicPluginId {
  return validatedId(value, 'Dynamic plugin ID') as DynamicPluginId;
}

export function pluginVersionId(value: string): PluginVersionId {
  return validatedId(value, 'Plugin version ID') as PluginVersionId;
}

export function pluginActivationId(value: string): PluginActivationId {
  return validatedId(value, 'Plugin activation ID') as PluginActivationId;
}

function validatedId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return normalized;
}

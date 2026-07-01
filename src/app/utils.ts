import type { ServiceToken, ExtensionPoint, Plugin } from './types';

export function createServiceToken<T>(name: string): ServiceToken<T> {
  return Symbol.for(`aether.service.${name}`) as ServiceToken<T>;
}

export function createExtensionPoint<T>(name: string): ExtensionPoint<T> {
  return Symbol.for(`aether.extension.${name}`) as ExtensionPoint<T>;
}

export function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

export function definePlugin(config: Plugin): Plugin {
  return config;
}

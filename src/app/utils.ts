import type {
  ExtensionPoint,
  Plugin,
  ServiceFactoryRegistration,
  ServiceOptions,
  ServiceToken,
  ServiceValueRegistration
} from './types';

export function createServiceToken<T>(name: string): ServiceToken<T> {
  return Symbol.for(`aether.service.${name}`) as ServiceToken<T>;
}

export function createExtensionPoint<T>(name: string): ExtensionPoint<T> {
  return Symbol.for(`aether.extension.${name}`) as ExtensionPoint<T>;
}

export function serviceValue<T>(
  value: T,
  options: Readonly<ServiceOptions<T>> = {}
): ServiceValueRegistration<T> {
  return { kind: 'value', value, options };
}

export function serviceFactory<T>(
  create: ServiceFactoryRegistration<T>['create'],
  options: Readonly<ServiceOptions<T>> = {}
): ServiceFactoryRegistration<T> {
  return { kind: 'factory', create, options };
}

export function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

export function definePlugin(config: Plugin): Plugin {
  return config;
}

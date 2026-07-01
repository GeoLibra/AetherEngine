import type {
  AppScope,
  ExtensionPoint,
  ServiceOptions,
  ServiceProvider,
  ServiceToken
} from './types';

interface ServiceEntry<T> {
  provider: ServiceProvider<T>;
  options: Required<ServiceOptions>;
  instance?: T;
  frameInstance?: T;
}

/**
 * Type-safe service container supporting scope-hierarchies and lifecycle hooks.
 * Provides isolation across runtime layers (e.g. Main thread, Render loop, Editor context).
 */
export class ServiceRegistry {
  private readonly services = new Map<AppScope, Map<ServiceToken<unknown>, ServiceEntry<unknown>>>();

  /**
   * Registers a service provider or factory function under a unique token.
   */
  provide<T>(token: ServiceToken<T>, provider: ServiceProvider<T>, options: ServiceOptions = {}): void {
    const scope = options.scope ?? 'main';
    let scopedServices = this.services.get(scope);
    if (!scopedServices) {
      scopedServices = new Map();
      this.services.set(scope, scopedServices);
    }

    if (scopedServices.has(token as ServiceToken<unknown>)) {
      console.warn(`Service "${token.description ?? token.toString()}" already registered, overwriting.`);
    }

    scopedServices.set(token as ServiceToken<unknown>, {
      provider,
      options: {
        scope,
        lifecycle: options.lifecycle ?? 'singleton',
        debugName: options.debugName ?? token.description ?? 'anonymous-service'
      }
    });
  }

  /**
   * Resolves and returns a service instance. Throws if not registered.
   */
  get<T>(token: ServiceToken<T>, scope: AppScope = 'main'): T {
    const service = this.tryGet(token, scope);
    if (service === undefined) {
      throw new Error(`Service "${token.description ?? token.toString()}" is not registered.`);
    }
    return service;
  }

  /**
   * Resolves a service instance by priority: scoped container first, falling back to global container.
   */
  tryGet<T>(token: ServiceToken<T>, scope: AppScope = 'main'): T | undefined {
    const scoped = this.services.get(scope)?.get(token as ServiceToken<unknown>);
    if (scoped) {
      return this.resolve(scoped as ServiceEntry<T>);
    }

    const global = this.services.get('global')?.get(token as ServiceToken<unknown>);
    if (!global) {
      return undefined;
    }
    return this.resolve(global as ServiceEntry<T>);
  }

  has<T>(token: ServiceToken<T>, scope: AppScope = 'main'): boolean {
    return (
      this.services.get(scope)?.has(token as ServiceToken<unknown>) === true ||
      this.services.get('global')?.has(token as ServiceToken<unknown>) === true
    );
  }

  /**
   * Wipes frame-cached instances. Triggered at the end of each tick 
   * to prepare for fresh resolution in the next frame.
   */
  clearFrameScoped(scope?: AppScope): void {
    const scopes: AppScope[] = scope ? [scope] : ['main', 'render', 'editor', 'asset-worker', 'global'];
    for (const targetScope of scopes) {
      const scopedServices = this.services.get(targetScope);
      if (!scopedServices) {
        continue;
      }

      for (const entry of scopedServices.values()) {
        if (entry.options.lifecycle === 'frame') {
          entry.frameInstance = undefined;
        }
      }
    }
  }

  /**
   * Resets all registrations and cached instances.
   */
  clear(): void {
    this.services.clear();
  }

  /**
   * Resolves a service entry based on its specified lifecycle rules.
   */
  private resolve<T>(entry: ServiceEntry<T>): T {
    if (entry.options.lifecycle === 'transient') {
      return this.create(entry);
    }

    if (entry.options.lifecycle === 'frame') {
      if (entry.frameInstance === undefined) {
        entry.frameInstance = this.create(entry);
      }
      return entry.frameInstance;
    }

    if (entry.instance === undefined) {
      entry.instance = this.create(entry);
    }
    return entry.instance;
  }

  /**
   * Instantiates a service by running its factory constructor or returning the raw instance.
   */
  private create<T>(entry: ServiceEntry<T>): T {
    if (typeof entry.provider === 'function') {
      return (entry.provider as (registry: ServiceRegistry) => T)(this);
    }
    return entry.provider;
  }
}

/**
 * Contributions registry for plugin extension slots.
 * Allows decoupling pluggable subsystems (e.g. file importers, shader graph nodes).
 */
export class ExtensionRegistry {
  private readonly contributions = new Map<ExtensionPoint<unknown>, unknown[]>();

  add<T>(point: ExtensionPoint<T>, contribution: T): void {
    const list = this.contributions.get(point as ExtensionPoint<unknown>);
    if (list) {
      list.push(contribution);
      return;
    }
    this.contributions.set(point as ExtensionPoint<unknown>, [contribution]);
  }

  list<T>(point: ExtensionPoint<T>): readonly T[] {
    return [...(this.contributions.get(point as ExtensionPoint<unknown>) ?? [])] as T[];
  }

  clear(): void {
    this.contributions.clear();
  }
}

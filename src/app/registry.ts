import { isPromiseLike } from '../core';
import type {
  AppScope,
  ExtensionContribution,
  ExtensionPoint,
  ExtensionSnapshot,
  RegistrationHandle,
  ServiceLifecycle,
  ServiceRegistration,
  ServiceResolver,
  ServiceToken
} from './types';

const DEFAULT_SCOPE_PARENTS: ReadonlyMap<AppScope, AppScope> = new Map([
  ['main', 'global'],
  ['render', 'global'],
  ['editor', 'global'],
  ['asset-worker', 'global']
]);

interface ServiceEntry<T> {
  readonly token: ServiceToken<T>;
  readonly scope: AppScope;
  readonly registration: ServiceRegistration<T>;
  readonly lifecycle: ServiceLifecycle;
  resolved: boolean;
  cached: boolean;
  cachedValue?: T;
}

interface ResolutionStep {
  readonly scope: AppScope;
  readonly token: ServiceToken<unknown>;
}

/** Owns scoped service registrations and the cached instances they create. */
export class ServiceRegistry implements ServiceResolver {
  private readonly entries = new Map<AppScope, Map<ServiceToken<unknown>, ServiceEntry<unknown>>>();
  private readonly resolutionStack: ResolutionStep[] = [];

  constructor(
    private readonly scopeParents: ReadonlyMap<AppScope, AppScope> = DEFAULT_SCOPE_PARENTS
  ) {}

  provide<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): RegistrationHandle {
    const entry = this.createEntry(token, registration);
    const scopedEntries = this.getOrCreateScope(entry.scope);
    if (scopedEntries.has(token as ServiceToken<unknown>)) {
      throw new Error(
        `Service "${tokenName(token)}" is already registered in scope "${entry.scope}".`
      );
    }

    scopedEntries.set(token as ServiceToken<unknown>, entry as ServiceEntry<unknown>);
    return createHandle(() => this.removeExact(entry));
  }

  replace<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): RegistrationHandle {
    const replacement = this.createEntry(token, registration);
    const scopedEntries = this.entries.get(replacement.scope);
    if (!scopedEntries) {
      throw new Error(
        `Service "${tokenName(token)}" is not registered in scope "${replacement.scope}".`
      );
    }
    const previous = scopedEntries.get(token as ServiceToken<unknown>);
    if (!previous) {
      throw new Error(
        `Service "${tokenName(token)}" is not registered in scope "${replacement.scope}".`
      );
    }
    if (previous.resolved) {
      throw new Error(
        `Service "${tokenName(token)}" in scope "${replacement.scope}" has already been resolved.`
      );
    }

    scopedEntries.set(token as ServiceToken<unknown>, replacement as ServiceEntry<unknown>);
    return createHandle(() => {
      if (scopedEntries.get(token as ServiceToken<unknown>) !== replacement) {
        return false;
      }
      scopedEntries.set(token as ServiceToken<unknown>, previous);
      return true;
    });
  }

  get<T>(token: ServiceToken<T>, scope: AppScope = 'main'): T {
    const entry = this.findEntry(token, scope);
    if (!entry) {
      throw new Error(`Service "${tokenName(token)}" is not registered for scope "${scope}".`);
    }
    return this.resolve(entry, scope);
  }

  tryGet<T>(token: ServiceToken<T>, scope: AppScope = 'main'): T | undefined {
    const entry = this.findEntry(token, scope);
    if (!entry) {
      return undefined;
    }
    return this.resolve(entry, scope);
  }

  has<T>(token: ServiceToken<T>, scope: AppScope = 'main'): boolean {
    return this.findEntry(token, scope) !== undefined;
  }

  clearFrameScoped(): readonly unknown[] {
    const errors: unknown[] = [];
    for (const scopedEntries of this.entries.values()) {
      for (const entry of scopedEntries.values()) {
        if (entry.lifecycle !== 'frame' || !entry.cached) {
          continue;
        }
        const value = entry.cachedValue;
        entry.cached = false;
        entry.cachedValue = undefined;
        const dispose = entry.registration.options.dispose;
        if (!dispose) {
          continue;
        }
        try {
          const result = dispose(value);
          if (isPromiseLike(result)) {
            void result.catch(() => undefined);
            errors.push(
              new Error(`Frame service "${tokenName(entry.token)}" disposal must be synchronous.`)
            );
          }
        } catch (error) {
          errors.push(error);
        }
      }
    }
    return Object.freeze(errors);
  }

  async disposeAll(): Promise<readonly unknown[]> {
    const errors: unknown[] = [...this.clearFrameScoped()];
    for (const scopedEntries of this.entries.values()) {
      for (const entry of scopedEntries.values()) {
        if (entry.lifecycle !== 'singleton' || !entry.cached) {
          continue;
        }
        const value = entry.cachedValue;
        entry.cached = false;
        entry.cachedValue = undefined;
        try {
          await entry.registration.options.dispose?.(value);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    return Object.freeze(errors);
  }

  clearRegistrations(): void {
    this.entries.clear();
    this.resolutionStack.length = 0;
  }

  private createEntry<T>(
    token: ServiceToken<T>,
    registration: ServiceRegistration<T>
  ): ServiceEntry<T> {
    const scope = registration.options.scope ?? 'main';
    return {
      token,
      scope,
      registration,
      lifecycle: registration.options.lifecycle ?? 'singleton',
      resolved: false,
      cached: false
    };
  }

  private findEntry<T>(token: ServiceToken<T>, scope: AppScope): ServiceEntry<T> | undefined {
    const visited = new Set<AppScope>();
    let current: AppScope | undefined = scope;
    while (current !== undefined) {
      if (visited.has(current)) {
        throw new Error(`Service scope parent cycle includes "${current}".`);
      }
      visited.add(current);
      const entry = this.entries.get(current)?.get(token as ServiceToken<unknown>);
      if (entry) {
        return entry as ServiceEntry<T>;
      }
      current = this.scopeParents.get(current);
    }
    return undefined;
  }

  private resolve<T>(entry: ServiceEntry<T>, requestedScope: AppScope): T {
    if (entry.lifecycle !== 'transient' && entry.cached) {
      return entry.cachedValue as T;
    }

    const cycleStart = this.resolutionStack.findIndex(
      (step) => step.scope === entry.scope && step.token === entry.token
    );
    if (cycleStart >= 0) {
      const cycle = [
        ...this.resolutionStack.slice(cycleStart).map((step) => tokenName(step.token)),
        tokenName(entry.token)
      ];
      throw new Error(`Service factory cycle: ${cycle.join(' -> ')}.`);
    }

    this.resolutionStack.push({
      scope: entry.scope,
      token: entry.token as ServiceToken<unknown>
    });
    try {
      const value =
        entry.registration.kind === 'value'
          ? entry.registration.value
          : entry.registration.create(this.createScopedResolver(requestedScope));
      entry.resolved = true;
      if (entry.lifecycle !== 'transient') {
        entry.cachedValue = value;
        entry.cached = true;
      }
      return value;
    } finally {
      this.resolutionStack.pop();
    }
  }

  private createScopedResolver(scope: AppScope): ServiceResolver {
    return {
      get: <T>(token: ServiceToken<T>, requestedScope: AppScope = scope): T =>
        this.get(token, requestedScope),
      tryGet: <T>(token: ServiceToken<T>, requestedScope: AppScope = scope): T | undefined =>
        this.tryGet(token, requestedScope)
    };
  }

  private getOrCreateScope(scope: AppScope): Map<ServiceToken<unknown>, ServiceEntry<unknown>> {
    const existing = this.entries.get(scope);
    if (existing) {
      return existing;
    }
    const created = new Map<ServiceToken<unknown>, ServiceEntry<unknown>>();
    this.entries.set(scope, created);
    return created;
  }

  private removeExact<T>(entry: ServiceEntry<T>): boolean {
    const scopedEntries = this.entries.get(entry.scope);
    const token = entry.token as ServiceToken<unknown>;
    if (!scopedEntries || scopedEntries.get(token) !== entry) {
      return false;
    }
    scopedEntries.delete(token);
    if (scopedEntries.size === 0) {
      this.entries.delete(entry.scope);
    }
    return true;
  }
}

interface StoredExtension<T> extends ExtensionSnapshot<T> {
  readonly order: number;
}

/** Owns multi-provider extension contributions and returns immutable snapshots. */
export class ExtensionRegistry {
  private readonly contributions = new Map<ExtensionPoint<unknown>, StoredExtension<unknown>[]>();
  private nextOrder = 0;

  add<T>(
    point: ExtensionPoint<T>,
    ownerPlugin: string,
    contribution: ExtensionContribution<T>
  ): RegistrationHandle {
    const entries = this.getOrCreatePoint(point);
    if (entries.some((entry) => entry.id === contribution.id)) {
      throw new Error(`duplicate extension contribution "${contribution.id}"`);
    }
    if (contribution.id.trim() === '') {
      throw new Error('Extension contribution id must not be empty.');
    }

    const stored: StoredExtension<T> = {
      id: contribution.id,
      priority: contribution.priority ?? 0,
      ownerPlugin,
      value: contribution.value,
      order: this.nextOrder++
    };
    entries.push(stored as StoredExtension<unknown>);
    return createHandle(() => this.removeExact(point, stored));
  }

  list<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[] {
    const entries = this.contributions.get(point as ExtensionPoint<unknown>) ?? [];
    const snapshot = [...entries]
      .sort((left, right) => right.priority - left.priority || left.order - right.order)
      .map((entry) =>
        Object.freeze({
          id: entry.id,
          priority: entry.priority,
          ownerPlugin: entry.ownerPlugin,
          value: entry.value as T
        })
      );
    return Object.freeze(snapshot);
  }

  removeOwner(ownerPlugin: string): void {
    for (const [point, entries] of this.contributions) {
      const remaining = entries.filter((entry) => entry.ownerPlugin !== ownerPlugin);
      if (remaining.length === 0) {
        this.contributions.delete(point);
      } else if (remaining.length !== entries.length) {
        this.contributions.set(point, remaining);
      }
    }
  }

  clear(): void {
    this.contributions.clear();
  }

  private getOrCreatePoint<T>(point: ExtensionPoint<T>): StoredExtension<unknown>[] {
    const key = point as ExtensionPoint<unknown>;
    const existing = this.contributions.get(key);
    if (existing) {
      return existing;
    }
    const created: StoredExtension<unknown>[] = [];
    this.contributions.set(key, created);
    return created;
  }

  private removeExact<T>(point: ExtensionPoint<T>, stored: StoredExtension<T>): boolean {
    const key = point as ExtensionPoint<unknown>;
    const entries = this.contributions.get(key);
    const index = entries?.indexOf(stored as StoredExtension<unknown>) ?? -1;
    if (!entries || index < 0) {
      return false;
    }
    entries.splice(index, 1);
    if (entries.length === 0) {
      this.contributions.delete(key);
    }
    return true;
  }
}

function createHandle(remove: () => boolean): RegistrationHandle {
  let active = true;
  return {
    remove(): boolean {
      if (!active) {
        return false;
      }
      const removed = remove();
      if (removed) {
        active = false;
      }
      return removed;
    }
  };
}

function tokenName(token: ServiceToken<unknown>): string {
  return token.description?.replace(/^aether\.service\./, '') ?? token.toString();
}

import type { PlatformServiceEntry, PlatformServiceRegistry, PlatformServiceToken } from './types';

interface StoredPlatformService {
  readonly token: PlatformServiceToken<unknown>;
  readonly value: unknown;
}

export function createPlatformServiceToken<T>(name: string): PlatformServiceToken<T> {
  if (name.trim().length === 0) {
    throw new Error('Platform service token name must not be empty.');
  }
  return Object.freeze({ key: Symbol(name), name });
}

export class MutablePlatformServiceRegistry implements PlatformServiceRegistry {
  private readonly services = new Map<symbol, StoredPlatformService>();

  provide<T>(token: PlatformServiceToken<T>, value: T): void {
    if (this.services.has(token.key)) {
      throw new Error(`Platform service "${token.name}" is already registered.`);
    }
    this.services.set(token.key, { token, value });
  }

  get<T>(token: PlatformServiceToken<T>): T {
    const service = this.services.get(token.key);
    if (service === undefined) {
      throw new Error(`Platform service "${token.name}" is not registered.`);
    }
    return service.value as T;
  }

  tryGet<T>(token: PlatformServiceToken<T>): T | undefined {
    return this.services.get(token.key)?.value as T | undefined;
  }

  list(): readonly PlatformServiceEntry[] {
    const entries = [...this.services.values()].map(({ token }) =>
      Object.freeze({ name: token.name, token })
    );
    return Object.freeze(entries);
  }
}

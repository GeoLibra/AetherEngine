import type { ResourceToken } from './types';

interface ResourceEntry {
  value: unknown;
  readonly protectedEntry: boolean;
}

export function defineResource<T>(debugName: string): ResourceToken<T> {
  const normalized = debugName.trim();
  if (normalized === '') {
    throw new Error('Resource token debugName must not be empty.');
  }
  return Object.freeze({
    id: Symbol(normalized),
    debugName: normalized
  });
}

export class ResourceStore {
  private readonly entries = new Map<symbol, ResourceEntry>();

  insert<T>(token: ResourceToken<T>, value: T, protectedEntry = false): void {
    if (this.entries.has(token.id)) {
      throw new Error(`Resource "${token.debugName}" is already registered.`);
    }
    this.entries.set(token.id, { value, protectedEntry });
  }

  replace<T>(token: ResourceToken<T>, value: T): T {
    const entry = this.entries.get(token.id);
    if (!entry) {
      throw new Error(`Resource "${token.debugName}" is not registered.`);
    }
    if (entry.protectedEntry) {
      throw new Error(`World resource "${token.debugName}" cannot be replaced.`);
    }
    const previous = entry.value as T;
    entry.value = value;
    return previous;
  }

  get<T>(token: ResourceToken<T>): T | undefined {
    return this.entries.get(token.id)?.value as T | undefined;
  }

  has<T>(token: ResourceToken<T>): boolean {
    return this.entries.has(token.id);
  }

  remove<T>(token: ResourceToken<T>): T | undefined {
    const entry = this.entries.get(token.id);
    if (!entry) {
      return undefined;
    }
    if (entry.protectedEntry) {
      throw new Error(`World resource "${token.debugName}" cannot be removed.`);
    }
    this.entries.delete(token.id);
    return entry.value as T;
  }

  clear(): void {
    this.entries.clear();
  }
}

import type {
  NativeHandle,
  NativeHandleLease,
  NativeHandleRegistryOptions
} from './handle-types';

interface HandleEntry<T> {
  readonly id: number;
  readonly generation: number;
  readonly type: string;
  readonly value: T;
  logical: boolean;
  leases: number;
}

export class NativeHandleContractError extends Error {
  constructor(readonly reason: 'owner' | 'generation' | 'type' | 'stale') {
    super(`Native handle ${reason} check failed.`);
    this.name = 'NativeHandleContractError';
  }
}

export class NativeHandleRegistry<T> {
  readonly owner: string;
  private readonly destroyValue: (value: T) => void;
  private readonly entries = new Map<number, HandleEntry<T>>();
  private generation = 1;
  private nextId = 1;

  constructor(options: NativeHandleRegistryOptions<T>) {
    if (options.owner.length === 0) throw new Error('Native handle owner must not be empty.');
    this.owner = options.owner;
    this.destroyValue = options.destroy;
  }

  get liveEntries(): number { return this.entries.size; }

  create<U extends T>(type: string, value: U): NativeHandle<U> {
    if (type.length === 0) throw new Error('Native handle type must not be empty.');
    const entry: HandleEntry<T> = {
      id: this.nextId++, generation: this.generation, type, value, logical: true, leases: 0
    };
    this.entries.set(entry.id, entry);
    return Object.freeze({ id: entry.id, generation: entry.generation, owner: this.owner });
  }

  resolve<U extends T>(handle: NativeHandle<U>, type: string): U {
    return this.requireEntry(handle, type).value as U;
  }

  lease<U extends T>(handle: NativeHandle<U>, type: string): NativeHandleLease<U> {
    const entry = this.requireEntry(handle, type);
    entry.leases += 1;
    let active = true;
    return Object.freeze({
      value: entry.value as U,
      release: (): boolean => {
        if (!active) return false;
        active = false;
        entry.leases -= 1;
        this.destroyIfReady(entry);
        return true;
      }
    });
  }

  release(handle: NativeHandle<T>): boolean {
    if (handle.owner !== this.owner) throw new NativeHandleContractError('owner');
    const entry = this.findCurrentEntry(handle);
    if (entry === undefined || !entry.logical) return false;
    entry.logical = false;
    this.destroyIfReady(entry);
    return true;
  }

  finalize(handle: NativeHandle<T>): boolean { return this.release(handle); }

  loseGeneration(): void {
    if (this.generation === Number.MAX_SAFE_INTEGER) {
      throw new Error('Native handle generation exhausted.');
    }
    const lost = [...this.entries.values()];
    this.generation += 1;
    for (const entry of lost) {
      entry.logical = false;
      this.destroyIfReady(entry);
    }
  }

  private requireEntry<U extends T>(handle: NativeHandle<U>, type: string): HandleEntry<T> {
    if (handle.owner !== this.owner) throw new NativeHandleContractError('owner');
    if (handle.generation !== this.generation) throw new NativeHandleContractError('generation');
    const entry = this.entries.get(handle.id);
    if (entry === undefined || !entry.logical) throw new NativeHandleContractError('stale');
    if (entry.generation !== handle.generation) throw new NativeHandleContractError('generation');
    if (entry.type !== type) throw new NativeHandleContractError('type');
    return entry;
  }

  private findCurrentEntry(handle: NativeHandle<T>): HandleEntry<T> | undefined {
    if (handle.owner !== this.owner || handle.generation !== this.generation) return undefined;
    const entry = this.entries.get(handle.id);
    return entry?.generation === handle.generation ? entry : undefined;
  }

  private destroyIfReady(entry: HandleEntry<T>): void {
    // Logical reachability and native in-flight safety are independent release gates.
    if (entry.logical || entry.leases !== 0 || !this.entries.delete(entry.id)) return;
    this.destroyValue(entry.value);
  }
}

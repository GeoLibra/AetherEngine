/**
 * Runtime-enforced read-only collection facades. `ReadonlyMap` and `ReadonlySet` are TypeScript
 * types only, so published collections must not expose the mutable collection that owns storage.
 */
export class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
  #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlySetSnapshot';
  }
}

export class ReadonlyMapSnapshot<K, V> implements ReadonlyMap<K, V> {
  #entries: Map<K, V>;

  constructor(entries: ReadonlyMap<K, V> | Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlyMapSnapshot';
  }
}

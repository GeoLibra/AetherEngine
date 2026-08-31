import type { RenderEntityFields } from './persistent-entity-map';
import { copyRenderFieldValue } from './render-field-snapshot';
import type { RenderEntityId, RenderFieldToken, RenderWorldChange, RenderWorldDiff } from './types';

export const FROZEN_MAP_INNERS = new WeakMap<object, ReadonlyMap<unknown, unknown>>();

/**
 * Immutable wrapper around ReadonlyMap with deep defensive cloning upon value access.
 */
export class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  #inner: ReadonlyMap<K, V>;
  #copyValue: (value: V) => V;

  constructor(inner: ReadonlyMap<K, V>, copyValue: (value: V) => V = identity) {
    this.#inner = inner;
    this.#copyValue = copyValue;
    FROZEN_MAP_INNERS.set(this, inner as ReadonlyMap<unknown, unknown>);
    Object.freeze(this);
  }

  get size(): number {
    return this.#inner.size;
  }
  get(key: K): V | undefined {
    const value = this.#inner.get(key);
    return value === undefined ? undefined : this.#copyValue(value);
  }
  has(key: K): boolean {
    return this.#inner.has(key);
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return new Map([...this.#inner].map(([key, value]) => [key, this.#copyValue(value)])).entries();
  }
  keys(): MapIterator<K> {
    return this.#inner.keys();
  }
  values(): MapIterator<V> {
    return new Map([...this.#inner].map(([key, value]) => [key, this.#copyValue(value)])).values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  get [Symbol.toStringTag](): string {
    return 'FrozenMap';
  }
}

export function freezeFields(values: Map<RenderFieldToken<unknown>, unknown>): RenderEntityFields {
  return new FrozenMap(values, copyRenderFieldValue);
}

export function copyCommittedFields(
  fields: RenderEntityFields | undefined
): Map<RenderFieldToken<unknown>, unknown> {
  const inner = fields && FROZEN_MAP_INNERS.get(fields);
  return new Map((inner ?? fields) as ReadonlyMap<RenderFieldToken<unknown>, unknown> | undefined);
}

function identity<T>(value: T): T {
  return value;
}

export function stableValueEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function packEntity(index: number, generation: number): RenderEntityId {
  return (index * 0x100000 + generation) as RenderEntityId;
}

export function unpackIndex(entity: RenderEntityId): number {
  return Math.floor(entity / 0x100000);
}

export function frozenDiff(
  previousRevision: number,
  nextRevision: number,
  changes: readonly RenderWorldChange[]
): RenderWorldDiff {
  return Object.freeze({ previousRevision, nextRevision, changes: Object.freeze([...changes]) });
}

export function changeRank(kind: RenderWorldChange['kind']): number {
  return kind === 'entity-added'
    ? 0
    : kind === 'entity-removed'
      ? 1
      : kind === 'field-added'
        ? 2
        : kind === 'field-changed'
          ? 3
          : 4;
}

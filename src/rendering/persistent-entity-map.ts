import type { RenderEntityId, RenderFieldToken } from './render-world';

export type RenderEntityFields = ReadonlyMap<RenderFieldToken<unknown>, unknown>;

const PAGE_BITS = 8;
const PAGE_SIZE = 1 << PAGE_BITS;
const LEVEL_BITS = 8;
const LEVEL_MASK = (1 << LEVEL_BITS) - 1;

type Page = ReadonlyMap<number, readonly [RenderEntityId, RenderEntityFields]>;
type Directory = ReadonlyMap<number, ReadonlyMap<number, Page>>;

/**
 * A persistent sparse map designed for ECS RenderWorld snapshots.
 * It uses a 3-level trie (high directory, middle branch, leaf page) to store
 * entities and their fields. When setting or deleting an entry, it copies only
 * the nodes along the edited path, allowing structural sharing across revisions
 * with O(log N) updates and minimal Garbage Collection pressure.
 */
export class PersistentEntityMap {
  static readonly empty = new PersistentEntityMap(new Map(), 0);

  private constructor(
    private readonly directory: Directory,
    readonly size: number
  ) {}

  /**
   * Retrieves the fields mapped to the given render entity.
   */
  get(entity: RenderEntityId): RenderEntityFields | undefined {
    return this.entry(entity)?.[1];
  }

  /**
   * Checks if the entity exists in this map.
   */
  has(entity: RenderEntityId): boolean {
    return this.entry(entity)?.[0] === entity;
  }

  /**
   * Returns a new PersistentEntityMap with the given entity and fields inserted.
   * Path copying is used: only the directory branch and leaf page along the path are cloned.
   */
  set(entity: RenderEntityId, fields: RenderEntityFields): PersistentEntityMap {
    const address = addressOf(entity);
    const branch = this.directory.get(address.high) ?? new Map<number, Page>();
    const page = branch.get(address.middle) ?? new Map();
    const existed = page.get(address.slot)?.[0] === entity;
    const nextPage = new Map(page);
    nextPage.set(address.slot, Object.freeze([entity, fields]));
    const nextBranch = new Map(branch);
    nextBranch.set(address.middle, nextPage);
    const nextDirectory = new Map(this.directory);
    nextDirectory.set(address.high, nextBranch);
    return new PersistentEntityMap(nextDirectory, this.size + (existed ? 0 : 1));
  }

  /**
   * Returns a new PersistentEntityMap with the specified entity removed.
   * Nodes along the edited path are updated or pruned if they become empty.
   */
  delete(entity: RenderEntityId): PersistentEntityMap {
    const address = addressOf(entity);
    const branch = this.directory.get(address.high);
    const page = branch?.get(address.middle);
    if (page?.get(address.slot)?.[0] !== entity) return this;
    const nextPage = new Map(page);
    nextPage.delete(address.slot);
    const nextBranch = new Map(branch);
    if (nextPage.size === 0) nextBranch.delete(address.middle);
    else nextBranch.set(address.middle, nextPage);
    const nextDirectory = new Map(this.directory);
    if (nextBranch.size === 0) nextDirectory.delete(address.high);
    else nextDirectory.set(address.high, nextBranch);
    return new PersistentEntityMap(nextDirectory, this.size - 1);
  }

  forEach(
    callbackfn: (value: RenderEntityFields, key: RenderEntityId, map: PersistentEntityMap) => void,
    thisArg?: unknown
  ): void {
    for (const [entity, fields] of this) callbackfn.call(thisArg, fields, entity, this);
  }

  *entries(): IterableIterator<[RenderEntityId, RenderEntityFields]> {
    for (const high of sortedKeys(this.directory)) {
      const branch = this.directory.get(high)!;
      for (const middle of sortedKeys(branch)) {
        const page = branch.get(middle)!;
        for (const slot of sortedKeys(page)) {
          const [entity, fields] = page.get(slot)!;
          yield [entity, fields];
        }
      }
    }
  }

  *keys(): IterableIterator<RenderEntityId> {
    for (const [entity] of this) yield entity;
  }

  *values(): IterableIterator<RenderEntityFields> {
    for (const [, fields] of this) yield fields;
  }

  [Symbol.iterator](): IterableIterator<[RenderEntityId, RenderEntityFields]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'PersistentEntityMap';
  }

  private entry(entity: RenderEntityId): readonly [RenderEntityId, RenderEntityFields] | undefined {
    const address = addressOf(entity);
    return this.directory.get(address.high)?.get(address.middle)?.get(address.slot);
  }
}

/**
 * Maps a packed RenderEntityId index to its three-level trie page offsets:
 * - high: root-level directory index
 * - middle: mid-level branch index
 * - slot: leaf-level 256-slot page index
 */
function addressOf(entity: RenderEntityId): { high: number; middle: number; slot: number } {
  const index = Math.floor(entity / 0x100000);
  const page = Math.floor(index / PAGE_SIZE);
  return {
    high: Math.floor(page / (LEVEL_MASK + 1)),
    middle: page & LEVEL_MASK,
    slot: index & (PAGE_SIZE - 1)
  };
}

function sortedKeys<T>(map: ReadonlyMap<number, T>): number[] {
  return [...map.keys()].sort((left, right) => left - right);
}

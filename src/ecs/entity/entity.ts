import {
  ENTITY_GENERATION_BITS,
  ENTITY_GENERATION_MASK,
  ENTITY_INDEX_MASK,
  ENTITY_INDEX_MULTIPLIER,
  ENTITY_LOCAL_MULTIPLIER,
  MAX_WORLD_ID
} from '../constants';
import type { Entity, WorldId } from '../types';

interface EntityMeta {
  generation: number;
  alive: boolean;
  retired: boolean;
}

export interface DecodedEntity {
  readonly worldId: WorldId;
  readonly index: number;
  readonly generation: number;
}

let nextWorldId = 1;

export function createWorldId(): WorldId {
  if (nextWorldId > MAX_WORLD_ID) {
    throw new Error('World id space is exhausted.');
  }
  return nextWorldId++ as WorldId;
}

export class EntityAllocator {
  private readonly entities: EntityMeta[] = [];
  private readonly freeList: number[] = [];
  private livingCount = 0;

  constructor(readonly worldId: WorldId) {}

  allocate(): Entity {
    const reused = this.freeList.pop();
    const index = reused ?? this.entities.length;

    if (index > ENTITY_INDEX_MASK) {
      throw new Error('Entity index space is exhausted.');
    }
    if (reused === undefined) {
      this.entities.push({ generation: 0, alive: false, retired: false });
    }

    const meta = this.entities[index];
    if (!meta || meta.retired) {
      throw new Error(`Entity slot "${index}" is unavailable.`);
    }

    meta.alive = true;
    this.livingCount++;
    return encodeEntity(this.worldId, index, meta.generation);
  }

  free(entity: Entity): boolean {
    const decoded = decodeEntity(entity);
    if (decoded.worldId !== this.worldId) {
      return false;
    }

    const meta = this.entities[decoded.index];
    if (!meta || !meta.alive || meta.generation !== decoded.generation) {
      return false;
    }

    meta.alive = false;
    this.livingCount--;

    if (meta.generation >= ENTITY_GENERATION_MASK) {
      // Retiring exhausted slots prevents ABA recycling bugs across long runtimes.
      meta.retired = true;
      return true;
    }

    meta.generation++;
    this.freeList.push(decoded.index);
    return true;
  }

  isAlive(entity: Entity): boolean {
    const decoded = decodeEntity(entity);
    if (decoded.worldId !== this.worldId) {
      return false;
    }

    const meta = this.entities[decoded.index];
    return meta !== undefined && meta.alive && meta.generation === decoded.generation;
  }

  *aliveEntities(): IterableIterator<Entity> {
    for (let index = 0; index < this.entities.length; index++) {
      const meta = this.entities[index]!;
      if (meta.alive) {
        yield encodeEntity(this.worldId, index, meta.generation);
      }
    }
  }

  clear(): void {
    this.entities.length = 0;
    this.freeList.length = 0;
    this.livingCount = 0;
  }

  get length(): number {
    return this.livingCount;
  }
}

export function encodeEntity(worldId: WorldId, index: number, generation: number): Entity {
  const local = index * ENTITY_INDEX_MULTIPLIER + generation;
  return (worldId * ENTITY_LOCAL_MULTIPLIER + local) as Entity;
}

export function decodeEntity(entity: Entity): DecodedEntity {
  const numeric = Number(entity);
  const worldId = Math.floor(numeric / ENTITY_LOCAL_MULTIPLIER) as WorldId;
  const local = numeric % ENTITY_LOCAL_MULTIPLIER;
  const index = Math.floor(local / ENTITY_INDEX_MULTIPLIER);
  const generation = local % ENTITY_INDEX_MULTIPLIER;

  return { worldId, index, generation };
}

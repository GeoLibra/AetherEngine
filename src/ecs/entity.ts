import {
  ENTITY_GENERATION_BITS,
  ENTITY_GENERATION_MASK,
  ENTITY_INDEX_MULTIPLIER
} from './constants';
import type { Entity } from './types';

interface EntityMeta {
  generation: number;
  alive: boolean;
}

export interface DecodedEntity {
  readonly index: number;
  readonly generation: number;
}

export class EntityAllocator {
  private readonly entities: EntityMeta[] = [];
  private readonly freeList: number[] = [];
  private livingCount = 0;

  allocate(): Entity {
    const reused = this.freeList.pop();
    const index = reused ?? this.entities.length;

    if (reused === undefined) {
      this.entities.push({ generation: 0, alive: false });
    }

    const meta = this.entities[index];
    if (!meta) {
      throw new Error(`Entity slot "${index}" was not allocated.`);
    }

    meta.alive = true;
    this.livingCount++;
    return encodeEntity(index, meta.generation);
  }

  free(entity: Entity): boolean {
    const decoded = decodeEntity(entity);
    const meta = this.entities[decoded.index];
    if (!meta || meta.generation !== decoded.generation || !meta.alive) {
      return false;
    }

    meta.alive = false;
    meta.generation = (meta.generation + 1) & ENTITY_GENERATION_MASK;
    this.freeList.push(decoded.index);
    this.livingCount--;
    return true;
  }

  isAlive(entity: Entity): boolean {
    const decoded = decodeEntity(entity);
    const meta = this.entities[decoded.index];
    return meta?.alive === true && meta.generation === decoded.generation;
  }

  aliveEntities(): Entity[] {
    const alive: Entity[] = [];
    for (let index = 0; index < this.entities.length; index++) {
      const meta = this.entities[index];
      if (meta?.alive === true) {
        alive.push(encodeEntity(index, meta.generation));
      }
    }
    return alive;
  }

  get count(): number {
    return this.livingCount;
  }
}

export function encodeEntity(index: number, generation: number): Entity {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Entity index must be a non-negative integer, received "${index}".`);
  }
  if (!Number.isInteger(generation) || generation < 0 || generation > ENTITY_GENERATION_MASK) {
    throw new Error(
      `Entity generation must fit in ${ENTITY_GENERATION_BITS} bits, received "${generation}".`
    );
  }
  return index * ENTITY_INDEX_MULTIPLIER + generation;
}

export function decodeEntity(entity: Entity): DecodedEntity {
  return {
    index: Math.floor(entity / ENTITY_INDEX_MULTIPLIER),
    generation: entity & ENTITY_GENERATION_MASK
  };
}

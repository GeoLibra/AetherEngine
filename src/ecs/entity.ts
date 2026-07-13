import {
  ENTITY_GENERATION_BITS,
  ENTITY_GENERATION_MASK,
  ENTITY_INDEX_MASK,
  ENTITY_INDEX_MULTIPLIER,
  ENTITY_LOCAL_MULTIPLIER,
  MAX_WORLD_ID
} from './constants';
import type { Entity, WorldId } from './types';

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
      throw new Error(
        `Entity "${entity}" belongs to World "${decoded.worldId}" and cannot be used cross-world in World "${this.worldId}".`
      );
    }
    const meta = this.entities[decoded.index];
    if (!meta || meta.generation !== decoded.generation || !meta.alive) {
      return false;
    }

    meta.alive = false;
    // Retiring at the generation ceiling prevents an old handle from becoming valid again.
    if (meta.generation === ENTITY_GENERATION_MASK) {
      meta.retired = true;
    } else {
      meta.generation++;
      this.freeList.push(decoded.index);
    }
    this.livingCount--;
    return true;
  }

  isAlive(entity: Entity): boolean {
    const decoded = decodeEntity(entity);
    if (decoded.worldId !== this.worldId) {
      return false;
    }
    const meta = this.entities[decoded.index];
    return meta?.alive === true && meta.generation === decoded.generation;
  }

  aliveEntities(): Entity[] {
    const alive: Entity[] = [];
    for (let index = 0; index < this.entities.length; index++) {
      const meta = this.entities[index];
      if (meta?.alive === true) {
        alive.push(encodeEntity(this.worldId, index, meta.generation));
      }
    }
    return alive;
  }

  get count(): number {
    return this.livingCount;
  }
}

export function encodeEntity(worldId: WorldId, index: number, generation: number): Entity {
  if (!Number.isInteger(worldId) || worldId < 0 || worldId > MAX_WORLD_ID) {
    throw new Error(`World id must be between 0 and ${MAX_WORLD_ID}, received "${worldId}".`);
  }
  if (!Number.isInteger(index) || index < 0 || index > ENTITY_INDEX_MASK) {
    throw new Error(
      `Entity index must be between 0 and ${ENTITY_INDEX_MASK}, received "${index}".`
    );
  }
  if (!Number.isInteger(generation) || generation < 0 || generation > ENTITY_GENERATION_MASK) {
    throw new Error(
      `Entity generation must fit in ${ENTITY_GENERATION_BITS} bits, received "${generation}".`
    );
  }
  // Multiplication avoids signed 32-bit bitshift behavior while preserving safe integer handles.
  return (worldId * ENTITY_LOCAL_MULTIPLIER +
    index * ENTITY_INDEX_MULTIPLIER +
    generation) as Entity;
}

export function decodeEntity(entity: Entity): DecodedEntity {
  if (!Number.isSafeInteger(entity) || entity < 0) {
    throw new Error(`Entity handle must be a non-negative safe integer, received "${entity}".`);
  }
  const worldId = Math.floor(entity / ENTITY_LOCAL_MULTIPLIER) as WorldId;
  const localHandle = entity - worldId * ENTITY_LOCAL_MULTIPLIER;
  return {
    worldId,
    index: Math.floor(localHandle / ENTITY_INDEX_MULTIPLIER),
    generation: localHandle % ENTITY_INDEX_MULTIPLIER
  };
}

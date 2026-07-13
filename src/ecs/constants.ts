import type { ComponentFieldType } from './types';

export const ENTITY_GENERATION_BITS = 12;
export const ENTITY_GENERATION_MASK = 2 ** ENTITY_GENERATION_BITS - 1;
export const ENTITY_INDEX_MULTIPLIER = 2 ** ENTITY_GENERATION_BITS;

export const DEFAULT_TABLE_INITIAL_CHUNK_CAPACITY = 4;
export const DEFAULT_TABLE_CHUNK_CAPACITY = 64;
export const DEFAULT_TABLE_CAPACITY = DEFAULT_TABLE_CHUNK_CAPACITY;

export const FIELD_TYPE_SIZES: Record<ComponentFieldType, number> = {
  f32: 4,
  i32: 4,
  u32: 4,
  vec2: 8,
  vec3: 12,
  vec4: 16,
  ivec3: 12,
  mat3: 36,
  mat4: 64,
  entity: 4
};

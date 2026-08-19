import type {
  ComponentField,
  ComponentFieldType,
  ComponentInput,
  PackedComponentSchema
} from '../types';

export const FLOAT_VECTOR_LENGTHS: Partial<Record<ComponentFieldType, number>> = Object.freeze({
  vec2: 2,
  vec3: 3,
  vec4: 4,
  mat3: 9,
  mat4: 16
});

export const INTEGER_VECTOR_LENGTHS: Partial<Record<ComponentFieldType, number>> = Object.freeze({
  ivec3: 3
});

export function serializeComponent(
  schema: PackedComponentSchema<object>,
  data: ComponentInput = {}
): ArrayBuffer {
  const buffer = new ArrayBuffer(schema.size);
  const view = new DataView(buffer);

  for (const field of schema.fields) {
    const value = data[field.name];
    writeField(view, field, value);
  }

  return buffer;
}

export function writeField(view: DataView, field: ComponentField, value: unknown): void {
  switch (field.packedType) {
    case 'f32':
      view.setFloat32(field.offset, toNumber(value), true);
      return;
    case 'i32':
      view.setInt32(field.offset, toNumber(value), true);
      return;
    case 'u32':
      view.setUint32(field.offset, toNumber(value), true);
      return;
    case 'entity':
      view.setFloat64(field.offset, toEntityNumber(value), true);
      return;
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'mat4':
    case 'mat3':
      writeFloatVector(view, field, value);
      return;
    case 'ivec3':
      writeIntegerVector(view, field, value);
      return;
  }
}

export function writeFloatVector(view: DataView, field: ComponentField, value: unknown): void {
  const length = FLOAT_VECTOR_LENGTHS[field.packedType] ?? 0;
  const values = isArrayLike(value) ? value : [];

  for (let index = 0; index < length; index++) {
    const fallback = field.packedType === 'vec4' && index === 3 ? 1 : 0;
    view.setFloat32(field.offset + index * 4, toNumber(values[index], fallback), true);
  }
}

export function writeIntegerVector(view: DataView, field: ComponentField, value: unknown): void {
  const length = INTEGER_VECTOR_LENGTHS[field.packedType] ?? 0;
  const values = isArrayLike(value) ? value : [];
  for (let index = 0; index < length; index++) {
    view.setInt32(field.offset + index * 4, toNumber(values[index]), true);
  }
}

export function isArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object' && value !== null && 'length' in value;
}

export function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function toEntityNumber(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Entity reference must be a non-negative safe integer, received "${value}".`);
  }
  return value;
}

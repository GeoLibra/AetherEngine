import { FIELD_TYPE_SIZES } from './constants';
import type {
  ComponentDefinition,
  ComponentField,
  ComponentFieldType,
  ComponentInput,
  ComponentSchema,
  Entity,
  RelationType
} from './types';

const FLOAT_VECTOR_LENGTHS: Partial<Record<ComponentFieldType, number>> = {
  vec2: 2,
  vec3: 3,
  vec4: 4,
  mat4: 16
};

export const ChildOf = defineRelation('ChildOf');
export const IsA = defineRelation('IsA');

export function defineRelation(name: string): RelationType {
  if (name.trim() === '') {
    throw new Error('Relation name must not be empty.');
  }
  return { name, id: Symbol(name) };
}

export function defineComponent<TView extends object>(
  definition: ComponentDefinition
): ComponentSchema<TView> {
  if (definition.name.trim() === '') {
    throw new Error('Component name must not be empty.');
  }

  let offset = 0;
  const fields: ComponentField[] = definition.fields.map((field) => {
    const size = FIELD_TYPE_SIZES[field.type];
    const resolved = { ...field, offset, size };
    offset += size;
    return resolved;
  });

  return {
    name: definition.name,
    fields,
    size: offset
  };
}

export function serializeComponent(
  schema: ComponentSchema<object>,
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

export function createComponentView<TView extends object>(
  schema: ComponentSchema<TView>,
  buffer: ArrayBuffer,
  row: number,
  markChanged: () => void
): TView {
  const byteOffset = row * schema.size;
  const dataView = new DataView(buffer, byteOffset, schema.size);
  const view: Record<string, unknown> = {};

  for (const field of schema.fields) {
    Object.defineProperty(view, field.name, {
      enumerable: true,
      configurable: false,
      get: () => readField(buffer, byteOffset, dataView, field, markChanged),
      set: (value: unknown) => {
        writeField(dataView, field, value);
        markChanged();
      }
    });
  }

  return view as TView;
}

function writeField(view: DataView, field: ComponentField, value: unknown): void {
  switch (field.type) {
    case 'f32':
      view.setFloat32(field.offset, toNumber(value), true);
      return;
    case 'i32':
      view.setInt32(field.offset, toNumber(value), true);
      return;
    case 'u32':
    case 'entity':
      view.setUint32(field.offset, toNumber(value), true);
      return;
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'mat4':
      writeFloatVector(view, field, value);
      return;
  }
}

function readField(
  buffer: ArrayBuffer,
  baseByteOffset: number,
  dataView: DataView,
  field: ComponentField,
  markChanged: () => void
): unknown {
  switch (field.type) {
    case 'f32':
      return dataView.getFloat32(field.offset, true);
    case 'i32':
      return dataView.getInt32(field.offset, true);
    case 'u32':
    case 'entity':
      return dataView.getUint32(field.offset, true) as Entity;
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'mat4':
      return createTrackedFloatVector(
        buffer,
        baseByteOffset + field.offset,
        FLOAT_VECTOR_LENGTHS[field.type] ?? 0,
        markChanged
      );
  }
}

function writeFloatVector(view: DataView, field: ComponentField, value: unknown): void {
  const length = FLOAT_VECTOR_LENGTHS[field.type] ?? 0;
  const values = isArrayLike(value) ? value : [];

  for (let index = 0; index < length; index++) {
    const fallback = field.type === 'vec4' && index === 3 ? 1 : 0;
    view.setFloat32(field.offset + index * 4, toNumber(values[index], fallback), true);
  }
}

function createTrackedFloatVector(
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
  markChanged: () => void
): Float32Array {
  const array = new Float32Array(buffer, byteOffset, length);

  return new Proxy(array, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      const didSet = Reflect.set(target, property, value, target);
      if (isNumericProperty(property)) {
        markChanged();
      }
      return didSet;
    }
  });
}

function isArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object' && value !== null && 'length' in value;
}

function isNumericProperty(property: string | symbol): boolean {
  return typeof property === 'string' && property.trim() !== '' && Number.isInteger(Number(property));
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

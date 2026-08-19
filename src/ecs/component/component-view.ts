import type { ComponentField, Entity, PackedComponentSchema } from '../types';
import type { ComponentStorage } from '../storage/table';
import { FLOAT_VECTOR_LENGTHS, INTEGER_VECTOR_LENGTHS, writeField } from './component-serializer';

export type { ComponentStorage };

// Component views intentionally resolve storage lazily. Tables can grow or entities can
// migrate between archetypes, so a view that captured a fixed ArrayBuffer would become stale.
export type ComponentStorageAccessor = () => ComponentStorage;
export type ComponentViewFactory<TView extends object> = (
  getStorage: ComponentStorageAccessor,
  markChanged: () => void
) => TView;

const VIEW_ACCESSOR = Symbol('ComponentView.accessor');
const VIEW_MARK_CHANGED = Symbol('ComponentView.markChanged');

// TypedArray mutating methods write through native code and do not trigger a Proxy set trap.
// Wrapping them is required for Bevy-style change filters to see vector writes.
const MUTATING_VECTOR_METHODS = new Set<PropertyKey>([
  'copyWithin',
  'fill',
  'reverse',
  'set',
  'sort'
]);

export function createComponentView<TView extends object>(
  schema: PackedComponentSchema<TView>,
  getStorage: ComponentStorageAccessor,
  markChanged: () => void
): TView {
  return compileComponentViewFactory(schema)(getStorage, markChanged);
}

export function compileComponentViewFactory<TView extends object>(
  schema: PackedComponentSchema<TView>
): ComponentViewFactory<TView> {
  // Define field accessors on the prototype once per schema. Query iteration still creates
  // lightweight view instances, but avoids redefining property descriptors for every row.
  class SchemaComponentView {
    readonly [VIEW_ACCESSOR]: ComponentStorageAccessor;
    readonly [VIEW_MARK_CHANGED]: () => void;

    constructor(getStorage: ComponentStorageAccessor, markChanged: () => void) {
      this[VIEW_ACCESSOR] = getStorage;
      this[VIEW_MARK_CHANGED] = markChanged;
    }
  }

  for (const field of schema.fields) {
    Object.defineProperty(SchemaComponentView.prototype, field.name, {
      enumerable: true,
      configurable: false,
      get(this: SchemaComponentView) {
        return readField(this[VIEW_ACCESSOR], schema, field, this[VIEW_MARK_CHANGED]);
      },
      set(this: SchemaComponentView, value: unknown) {
        const storage = this[VIEW_ACCESSOR]();
        const dataView = new DataView(storage.buffer, storage.row * schema.size, schema.size);
        writeField(dataView, field, value);
        this[VIEW_MARK_CHANGED]();
      }
    });
  }

  return (getStorage, markChanged) => new SchemaComponentView(getStorage, markChanged) as TView;
}

export function readField(
  getStorage: ComponentStorageAccessor,
  schema: PackedComponentSchema<object>,
  field: ComponentField,
  markChanged: () => void
): unknown {
  // Always ask the accessor for current storage. The entity may have moved to a new row/table
  // since this view was created because of table growth or archetype migration.
  const storage = getStorage();
  const byteOffset = storage.row * schema.size;
  const dataView = new DataView(storage.buffer, byteOffset, schema.size);

  switch (field.packedType) {
    case 'f32':
      return dataView.getFloat32(field.offset, true);
    case 'i32':
      return dataView.getInt32(field.offset, true);
    case 'u32':
      return dataView.getUint32(field.offset, true);
    case 'entity':
      return dataView.getFloat64(field.offset, true) as Entity;
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'mat4':
    case 'mat3':
      return createTrackedFloatVector(
        () => {
          const current = getStorage();
          return {
            buffer: current.buffer,
            byteOffset: current.row * schema.size + field.offset
          };
        },
        FLOAT_VECTOR_LENGTHS[field.packedType] ?? 0,
        markChanged
      );
    case 'ivec3':
      return createTrackedIntegerVector(
        () => {
          const current = getStorage();
          return {
            buffer: current.buffer,
            byteOffset: current.row * schema.size + field.offset
          };
        },
        INTEGER_VECTOR_LENGTHS[field.packedType] ?? 0,
        markChanged
      );
  }
}

export function createTrackedFloatVector(
  getVectorStorage: () => { readonly buffer: ArrayBuffer; readonly byteOffset: number },
  length: number,
  markChanged: () => void
): Float32Array {
  // The proxy target is only a shape carrier. Every operation refreshes the real target so
  // cached vectors survive table reallocations and relation/component migrations.
  const getTarget = (): Float32Array => {
    const storage = getVectorStorage();
    return new Float32Array(storage.buffer, storage.byteOffset, length);
  };
  return createTrackedTypedArray(getTarget, markChanged);
}

export function createTrackedIntegerVector(
  getVectorStorage: () => { readonly buffer: ArrayBuffer; readonly byteOffset: number },
  length: number,
  markChanged: () => void
): Int32Array {
  const getTarget = (): Int32Array => {
    const storage = getVectorStorage();
    return new Int32Array(storage.buffer, storage.byteOffset, length);
  };
  return createTrackedTypedArray(getTarget, markChanged);
}

export function createTrackedTypedArray<T extends Float32Array | Int32Array>(
  getTarget: () => T,
  markChanged: () => void
): T {
  return new Proxy(getTarget(), {
    get(_target, property) {
      const target = getTarget();
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') {
        return value;
      }
      if (MUTATING_VECTOR_METHODS.has(property)) {
        return (...args: unknown[]) => {
          const result = (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
          markChanged();
          return result;
        };
      }
      return value.bind(target);
    },
    set(_target, property, value) {
      const target = getTarget();
      const didSet = Reflect.set(target, property, value, target);
      if (isNumericProperty(property)) {
        markChanged();
      }
      return didSet;
    }
  });
}

function isNumericProperty(property: string | symbol): boolean {
  return (
    typeof property === 'string' && property.trim() !== '' && Number.isInteger(Number(property))
  );
}

import { FIELD_TYPE_SIZES } from './constants';
import { defineSchema } from '../schema';
import type { ValidationIssue, ValidationResult, ValueTypeDefinition } from '../schema/types';
import { cloneUnknown } from '../schema/migration';
import type {
  ComponentDefinition,
  ComponentField,
  ComponentFieldType,
  ComponentInput,
  ComponentSchema,
  Entity,
  ObjectComponentDefinition,
  ObjectComponentSchema,
  PackedComponentSchema,
  RelationOptions,
  RelationType,
  TagComponentDefinition,
  TagComponentSchema
} from './types';

export interface ComponentStorage {
  readonly buffer: ArrayBuffer;
  readonly row: number;
}

// Component views intentionally resolve storage lazily. Tables can grow or entities can
// migrate between archetypes, so a view that captured a fixed ArrayBuffer would become stale.
export type ComponentStorageAccessor = () => ComponentStorage;
export type ComponentViewFactory<TView extends object> = (
  getStorage: ComponentStorageAccessor,
  markChanged: () => void
) => TView;

const FLOAT_VECTOR_LENGTHS: Partial<Record<ComponentFieldType, number>> = {
  vec2: 2,
  vec3: 3,
  vec4: 4,
  mat3: 9,
  mat4: 16
};

const INTEGER_VECTOR_LENGTHS: Partial<Record<ComponentFieldType, number>> = {
  ivec3: 3
};

const NO_TAG_COMPONENT_FIELDS: readonly [] = Object.freeze([]);

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

let nextRelationId = 0;

export const ChildOf = defineRelation('ChildOf', { acyclic: true });
export const IsA = defineRelation('IsA', { acyclic: true });

export function defineRelation(name: string, options: RelationOptions = {}): RelationType {
  if (name.trim() === '') {
    throw new Error('Relation name must not be empty.');
  }
  // `key` is stable for table tags even if two relation tokens share the same debug name.
  return {
    name,
    id: Symbol(name),
    key: `${name}:${nextRelationId++}`,
    acyclic: options.acyclic ?? false
  };
}

export function defineComponent<TView extends object>(
  definition: ComponentDefinition
): PackedComponentSchema<TView> {
  if (definition.name.trim() === '') {
    throw new Error('Component name must not be empty.');
  }

  const schema = defineSchema<TView>({
    id: definition.id,
    version: definition.version,
    kind: 'component',
    storage: 'packed',
    fields: definition.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: toValueType(field.type),
      required: field.required ?? field.type !== 'entity',
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : field.type === 'entity'
          ? {}
          : { defaultValue: defaultPackedValue(field.type) }),
      compare: field.compare ?? 'exact',
      serialization: field.serialization ?? 'save',
      ...(field.editor === undefined ? {} : { editor: field.editor }),
      ...(field.replication === undefined ? {} : { replication: field.replication })
    })),
    validate:
      (definition.validate as ((input: unknown) => ValidationResult<TView>) | undefined) ??
      ((input) => validatePackedComponent<TView>(definition, input))
  });

  let offset = 0;
  const fields: ComponentField[] = schema.fields.map((field, index) => {
    const packedType = definition.fields[index]!.type;
    const size = FIELD_TYPE_SIZES[packedType];
    const resolved = Object.freeze({ ...field, packedType, offset, size });
    offset += size;
    return resolved;
  });

  return Object.freeze({
    ...schema,
    kind: 'component' as const,
    storage: 'packed' as const,
    name: definition.name,
    fields: Object.freeze(fields),
    size: offset
  });
}

export function defineObjectComponent<TView extends object>(
  definition: ObjectComponentDefinition<TView>
): ObjectComponentSchema<TView> {
  assertComponentName(definition.name);
  const schema = defineSchema<TView>({
    id: definition.id,
    version: definition.version,
    kind: 'component',
    storage: 'object',
    fields: definition.fields,
    validate: definition.validate
  });
  return Object.freeze({
    ...schema,
    kind: 'component' as const,
    name: definition.name,
    storage: 'object' as const
  });
}

export function defineTagComponent(definition: TagComponentDefinition): TagComponentSchema {
  assertComponentName(definition.name);
  const schema = defineSchema<Record<string, never>>({
    id: definition.id,
    version: definition.version,
    kind: 'component',
    storage: 'tag',
    fields: [],
    validate(input) {
      return typeof input === 'object' && input !== null && Object.keys(input).length === 0
        ? { ok: true, value: Object.freeze({}) }
        : { ok: false, issues: [{ path: [], message: 'Tag components cannot contain payload.' }] };
    }
  });
  return Object.freeze({
    ...schema,
    kind: 'component' as const,
    name: definition.name,
    storage: 'tag' as const,
    fields: NO_TAG_COMPONENT_FIELDS
  });
}

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

export function validateComponentInput(
  schema: ComponentSchema<object>,
  data: ComponentInput
): void {
  if (schema.storage === 'tag') {
    if (Object.keys(data).length > 0) {
      throw new Error(`Tag component "${schema.id}" cannot contain payload.`);
    }
    return;
  }
  if (schema.storage === 'object') {
    createObjectComponentValue(schema, data);
    return;
  }
  const input: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (Object.hasOwn(data, field.name)) {
      input[field.name] = cloneUnknown(data[field.name]);
    } else if (field.defaultValue !== undefined) {
      input[field.name] = cloneUnknown(field.defaultValue);
    }
  }
  const validation = schema.validate(Object.freeze(input));
  if (!validation.ok) {
    const details = validation.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Component "${schema.id}" input failed schema validation: ${details}`);
  }
}

export function createObjectComponentValue<TView extends object>(
  schema: ObjectComponentSchema<TView>,
  data: ComponentInput
): TView {
  const input: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (Object.hasOwn(data, field.name)) {
      input[field.name] = cloneUnknown(data[field.name]);
    } else if (field.defaultValue !== undefined) {
      input[field.name] = cloneUnknown(field.defaultValue);
    }
  }
  const validation = schema.validate(Object.freeze(input));
  if (!validation.ok) {
    throwValidationError(schema, validation.issues);
  }
  return cloneUnknown(validation.value) as TView;
}

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

function writeField(view: DataView, field: ComponentField, value: unknown): void {
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

function readField(
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

function assertComponentName(name: string): void {
  if (name.trim() === '') {
    throw new Error('Component name must not be empty.');
  }
}

function throwValidationError(
  schema: ComponentSchema<object>,
  issues: readonly ValidationIssue[]
): never {
  const details = issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Component "${schema.id}" input failed schema validation: ${details}`);
}

function writeFloatVector(view: DataView, field: ComponentField, value: unknown): void {
  const length = FLOAT_VECTOR_LENGTHS[field.packedType] ?? 0;
  const values = isArrayLike(value) ? value : [];

  for (let index = 0; index < length; index++) {
    const fallback = field.packedType === 'vec4' && index === 3 ? 1 : 0;
    view.setFloat32(field.offset + index * 4, toNumber(values[index], fallback), true);
  }
}

function writeIntegerVector(view: DataView, field: ComponentField, value: unknown): void {
  const length = INTEGER_VECTOR_LENGTHS[field.packedType] ?? 0;
  const values = isArrayLike(value) ? value : [];
  for (let index = 0; index < length; index++) {
    view.setInt32(field.offset + index * 4, toNumber(values[index]), true);
  }
}

function createTrackedFloatVector(
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

function createTrackedIntegerVector(
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

function createTrackedTypedArray<T extends Float32Array | Int32Array>(
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

function isArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object' && value !== null && 'length' in value;
}

function isNumericProperty(property: string | symbol): boolean {
  return (
    typeof property === 'string' && property.trim() !== '' && Number.isInteger(Number(property))
  );
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toEntityNumber(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Entity reference must be a non-negative safe integer, received "${value}".`);
  }
  return value;
}

function toValueType(type: ComponentFieldType): ValueTypeDefinition {
  switch (type) {
    case 'f32':
    case 'i32':
    case 'u32':
      return { kind: 'number', format: type };
    case 'vec2':
      return { kind: 'vector', length: 2 };
    case 'vec3':
      return { kind: 'vector', length: 3 };
    case 'vec4':
      return { kind: 'vector', length: 4 };
    case 'ivec3':
      return { kind: 'vector', length: 3, format: 'i32' };
    case 'mat4':
      return { kind: 'matrix', columns: 4, rows: 4 };
    case 'mat3':
      return { kind: 'matrix', columns: 3, rows: 3 };
    case 'entity':
      return { kind: 'entity-ref', policy: 'required' };
  }
}

function defaultPackedValue(type: ComponentFieldType): number | readonly number[] {
  switch (type) {
    case 'vec2':
      return Object.freeze([0, 0]);
    case 'vec3':
      return Object.freeze([0, 0, 0]);
    case 'vec4':
      return Object.freeze([0, 0, 0, 1]);
    case 'mat4':
      return Object.freeze(Array.from({ length: 16 }, () => 0));
    case 'mat3':
      return Object.freeze(Array.from({ length: 9 }, () => 0));
    case 'ivec3':
      return Object.freeze([0, 0, 0]);
    default:
      return 0;
  }
}

function validatePackedComponent<TView extends object>(
  definition: ComponentDefinition,
  input: unknown
): ValidationResult<TView> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: [], message: 'Expected a component object.' }] };
  }

  const record = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const field of definition.fields) {
    const value = record[field.name];
    if (value === undefined && (field.required ?? field.type !== 'entity') === false) {
      continue;
    }
    if (!isPackedValue(value, field.type)) {
      issues.push({ path: [field.id], message: `Expected packed ${field.type} value.` });
    }
  }
  return issues.length === 0
    ? { ok: true, value: record as TView }
    : { ok: false, issues: Object.freeze(issues) };
}

function isPackedValue(value: unknown, type: ComponentFieldType): boolean {
  if (type === 'f32' || type === 'i32' || type === 'u32' || type === 'entity') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (type !== 'entity' || (Number.isSafeInteger(value) && value >= 0)) &&
      (type !== 'f32' || Number.isFinite(Math.fround(value)))
    );
  }
  const length = FLOAT_VECTOR_LENGTHS[type] ?? INTEGER_VECTOR_LENGTHS[type] ?? 0;
  if (!isArrayLike(value) || value.length !== length) {
    return false;
  }
  return Array.from(value).every(
    (entry) =>
      typeof entry === 'number' &&
      Number.isFinite(entry) &&
      (type === 'ivec3' || Number.isFinite(Math.fround(entry))) &&
      (type !== 'ivec3' || (Number.isInteger(entry) && entry >= -2147483648 && entry <= 2147483647))
  );
}

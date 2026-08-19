import { FIELD_TYPE_SIZES } from '../constants';
import { defineSchema } from '../../schema';
import type { ValidationIssue, ValidationResult, ValueTypeDefinition } from '../../schema/types';
import { cloneUnknown } from '../../schema/migration';
import type {
  ComponentDefinition,
  ComponentField,
  ComponentFieldType,
  ComponentInput,
  ComponentSchema,
  ObjectComponentDefinition,
  ObjectComponentSchema,
  PackedComponentSchema,
  TagComponentDefinition,
  TagComponentSchema
} from '../types';
import { FLOAT_VECTOR_LENGTHS, INTEGER_VECTOR_LENGTHS, isArrayLike } from './component-serializer';

const NO_TAG_COMPONENT_FIELDS: readonly [] = Object.freeze([]);

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

export function assertComponentName(name: string): void {
  if (name.trim() === '') {
    throw new Error('Component name must not be empty.');
  }
}

export function throwValidationError(
  schema: ComponentSchema<object>,
  issues: readonly ValidationIssue[]
): never {
  const details = issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Component "${schema.id}" input failed schema validation: ${details}`);
}

export function toValueType(type: ComponentFieldType): ValueTypeDefinition {
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

export function defaultPackedValue(type: ComponentFieldType): number | readonly number[] {
  switch (type) {
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'vec4':
      return [0, 0, 0, 1];
    case 'mat4':
      return Array.from({ length: 16 }, () => 0);
    case 'mat3':
      return Array.from({ length: 9 }, () => 0);
    case 'ivec3':
      return [0, 0, 0];
    default:
      return 0;
  }
}

export function validatePackedComponent<TView extends object>(
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

export function isPackedValue(value: unknown, type: ComponentFieldType): boolean {
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

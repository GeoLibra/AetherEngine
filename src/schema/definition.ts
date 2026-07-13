import type {
  FieldDefinition,
  FieldId,
  FieldSchema,
  SchemaDefinition,
  SchemaId,
  SchemaVersion,
  TypeSchema,
  ValueType,
  ValueTypeDefinition
} from './types';
import { cloneUnknown, freezeUnknown } from './migration';

const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const FIELD_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

export function defineSchema<T>(definition: SchemaDefinition<T>): TypeSchema<T> {
  if (!SCHEMA_ID_PATTERN.test(definition.id)) {
    throw new Error(`Schema id "${definition.id}" must be a namespaced stable id.`);
  }
  if (!Number.isInteger(definition.version) || definition.version <= 0) {
    throw new Error('Schema version must be a positive integer.');
  }
  if (definition.storage === 'tag' && definition.fields.length > 0) {
    throw new Error(`Tag schema "${definition.id}" cannot declare fields.`);
  }
  if (definition.kind === 'component' && definition.storage === undefined) {
    throw new Error(`Component schema "${definition.id}" must declare a storage strategy.`);
  }

  const fieldIds = new Set<string>();
  const fieldNames = new Set<string>();
  const fields = definition.fields.map((field) => {
    validateField(definition.id, field, fieldIds, fieldNames);
    if (definition.storage === 'packed' && !isPackedType(field.type)) {
      throw new Error(
        `Packed schema "${definition.id}" field "${field.id}" must use a fixed-size value type.`
      );
    }
    return freezeField(definition.id, field);
  });

  return Object.freeze({
    id: definition.id as SchemaId,
    version: definition.version as SchemaVersion,
    kind: definition.kind,
    ...(definition.storage === undefined ? {} : { storage: definition.storage }),
    fields: Object.freeze(fields),
    validate: definition.validate
  });
}

function validateField(
  schemaId: string,
  field: FieldDefinition,
  fieldIds: Set<string>,
  fieldNames: Set<string>
): void {
  if (!FIELD_ID_PATTERN.test(field.id)) {
    throw new Error(`Schema "${schemaId}" has invalid field id "${field.id}".`);
  }
  if (field.name.trim() === '') {
    throw new Error(`Schema "${schemaId}" has a field with an empty name.`);
  }
  if (fieldIds.has(field.id)) {
    throw new Error(`Schema "${schemaId}" has duplicate field id "${field.id}".`);
  }
  if (fieldNames.has(field.name)) {
    throw new Error(`Schema "${schemaId}" has duplicate field name "${field.name}".`);
  }
  fieldIds.add(field.id);
  fieldNames.add(field.name);
}

function freezeField(schemaId: string, field: FieldDefinition): FieldSchema {
  const type = freezeValueType(schemaId, field.type);
  if (field.defaultValue !== undefined && !isValueOfType(field.defaultValue, type)) {
    throw new Error(
      `Schema "${schemaId}" field "${field.id}" has a default value that does not match its type.`
    );
  }
  return Object.freeze({
    ...field,
    id: field.id as FieldId,
    type,
    ...(field.defaultValue === undefined
      ? {}
      : { defaultValue: freezeUnknown(cloneUnknown(field.defaultValue)) }),
    ...(field.editor === undefined
      ? {}
      : {
          editor: Object.freeze({
            ...field.editor,
            ...(field.editor.range === undefined
              ? {}
              : { range: Object.freeze([...field.editor.range]) as readonly [number, number] })
          })
        }),
    ...(field.replication === undefined
      ? {}
      : { replication: Object.freeze({ ...field.replication }) })
  });
}

function freezeValueType(schemaId: string, type: ValueTypeDefinition): ValueType {
  switch (type.kind) {
    case 'enum': {
      if (type.values.length === 0 || new Set(type.values).size !== type.values.length) {
        throw new Error(`Schema "${schemaId}" enum values must be non-empty and unique.`);
      }
      return Object.freeze({ ...type, values: Object.freeze([...type.values]) });
    }
    case 'array': {
      const element = freezeValueType(schemaId, type.element);
      if (type.elementKey !== undefined) {
        if (element.kind !== 'struct') {
          throw new Error(
            `Schema "${schemaId}" array elementKey requires a struct element type.`
          );
        }
        const keyField = element.fields.find(
          (field) => String(field.id) === type.elementKey
        );
        if (!keyField || !isStableKeyType(keyField.type)) {
          throw new Error(
            `Schema "${schemaId}" array elementKey "${type.elementKey}" must name a string, enum, or integer struct field.`
          );
        }
      }
      return Object.freeze({
        kind: 'array' as const,
        element,
        ...(type.elementKey === undefined
          ? {}
          : { elementKey: type.elementKey as FieldId })
      });
    }
    case 'map':
      return Object.freeze({ ...type, value: freezeValueType(schemaId, type.value) });
    case 'struct': {
      const ids = new Set<string>();
      const names = new Set<string>();
      const fields = type.fields.map((field) => {
        const definition = { ...field, id: String(field.id) };
        validateField(schemaId, definition, ids, names);
        return freezeField(schemaId, definition);
      });
      return Object.freeze({ ...type, fields: Object.freeze(fields) });
    }
    case 'asset-ref':
      if (type.expectedType !== undefined && !SCHEMA_ID_PATTERN.test(type.expectedType)) {
        throw new Error(
          `Schema "${schemaId}" asset reference expectedType must be a namespaced stable id.`
        );
      }
      return Object.freeze({ ...type });
    default:
      return Object.freeze({ ...type });
  }
}

function isPackedType(type: ValueTypeDefinition): boolean {
  switch (type.kind) {
    case 'boolean':
    case 'number':
    case 'vector':
    case 'matrix':
    case 'entity-ref':
      return true;
    case 'struct':
      return type.fields.every((field) => isPackedType(field.type));
    default:
      return false;
  }
}

function isStableKeyType(type: ValueType): boolean {
  return (
    type.kind === 'string' ||
    type.kind === 'enum' ||
    (type.kind === 'number' && (type.format === 'i32' || type.format === 'u32'))
  );
}

function isValueOfType(value: unknown, type: ValueType): boolean {
  switch (type.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return isNumberOfFormat(value, type.format);
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && type.values.includes(value);
    case 'vector':
      return isNumericArray(value, type.length, type.format);
    case 'matrix':
      return isNumericArray(value, type.columns * type.rows);
    case 'array':
      return Array.isArray(value) && value.every((entry) => isValueOfType(entry, type.element));
    case 'map':
      return isRecord(value) && Object.values(value).every((entry) => isValueOfType(entry, type.value));
    case 'struct':
      return (
        isRecord(value) &&
        type.fields.every((field) => {
          if (Object.hasOwn(value, field.name)) {
            return isValueOfType(value[field.name], field.type);
          }
          return !field.required || field.defaultValue !== undefined;
        })
      );
    case 'entity-ref':
      return isRecord(value) && value.kind === 'entity' && typeof value.id === 'string';
    case 'asset-ref':
      return isRecord(value) && value.kind === 'asset' && typeof value.id === 'string';
  }
}

function isNumberOfFormat(value: unknown, format: 'f32' | 'f64' | 'i32' | 'u32'): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  if (format === 'i32') {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  }
  if (format === 'u32') {
    return Number.isInteger(value) && value >= 0 && value <= 4294967295;
  }
  return format === 'f64' || Number.isFinite(Math.fround(value));
}

function isNumericArray(
  value: unknown,
  length: number,
  format: 'f32' | 'i32' | 'u32' = 'f32'
): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => isNumberOfFormat(entry, format))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

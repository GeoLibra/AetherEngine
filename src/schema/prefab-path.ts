import { isRecord } from '../core';
import { cloneUnknown } from './utils';
import type {
  FieldSchema,
  FieldId,
  PrefabOverridePath,
  PrefabOverridePathDefinition,
  PrefabPathSegment,
  TypeSchema,
  ValueType
} from './types';

/**
 * Validates and creates an immutable `PrefabOverridePath` from an authoring definition.
 *
 * Rejects numerical array indexing, enforcing stable `FieldId` or `elementKey` path segments.
 *
 * @param definition - The raw definition specifying local entity ID, schema, and path segments.
 * @returns A validated, deeply frozen `PrefabOverridePath`.
 * @throws {Error} If localEntityId, schema, or segment keys are empty, or if an unsupported segment kind is provided.
 */
export function createPrefabOverridePath(
  definition: PrefabOverridePathDefinition
): PrefabOverridePath {
  if (definition.localEntityId.trim() === '') {
    throw new Error('Prefab override localEntityId must not be empty.');
  }
  if (definition.schema.trim() === '') {
    throw new Error('Prefab override schema must not be empty.');
  }
  if (definition.segments.length === 0) {
    throw new Error('Prefab override path must contain at least one segment.');
  }
  const segments = definition.segments.map((segment): PrefabPathSegment => {
    if (segment.kind === 'field') {
      if (segment.id.trim() === '') {
        throw new Error('Prefab override field id must not be empty.');
      }
      return Object.freeze({ kind: 'field', id: segment.id as FieldId });
    }
    if (segment.kind === 'element' || segment.kind === 'map') {
      if (segment.key.trim() === '') {
        throw new Error(`Prefab override ${segment.kind} key must not be empty.`);
      }
      return Object.freeze({ ...segment });
    }
    throw new Error('Prefab override paths cannot use an array index; use a stable element key.');
  });
  return Object.freeze({
    localEntityId: definition.localEntityId,
    schema: definition.schema as PrefabOverridePath['schema'],
    segments: Object.freeze(segments)
  });
}

/**
 * Applies a replacement value at the targeted `PrefabOverridePath` within a schema-typed value.
 *
 * Navigates through nested struct fields, element keyed array items, and map keys.
 * Validates the modified instance against the schema before returning.
 *
 * @typeParam T - The typed schema value.
 * @param schema - The schema describing the root data structure.
 * @param value - The base instance to clone and patch.
 * @param path - The validated override path.
 * @param replacement - The replacement value to inject at the path target.
 * @returns A cloned and validated instance with the patch applied.
 * @throws {Error} If the schema mismatch, path is unresolvable, element key is duplicated/missing, or schema validation fails.
 */
export function applyPrefabOverride<T>(
  schema: TypeSchema<T>,
  value: T,
  path: PrefabOverridePath,
  replacement: unknown
): T {
  if (path.schema !== schema.id) {
    throw new Error(`Prefab override schema "${path.schema}" does not match "${schema.id}".`);
  }
  const cloned = cloneUnknown(value);
  let cursor: unknown = cloned;
  let type: ValueType = { kind: 'struct', fields: schema.fields };

  path.segments.forEach((segment, index) => {
    const last = index === path.segments.length - 1;
    if (segment.kind === 'field') {
      if (type.kind !== 'struct' || !isRecord(cursor)) {
        throw invalidPath(index, 'field segment requires a struct value');
      }
      const field = findField(type.fields, segment.id);
      if (!field) {
        throw invalidPath(index, `unknown stable field id "${segment.id}"`);
      }
      if (last) {
        cursor[field.name] = cloneUnknown(replacement);
        return;
      }
      cursor = cursor[field.name];
      type = field.type;
      return;
    }
    if (segment.kind === 'element') {
      if (type.kind !== 'array' || !Array.isArray(cursor) || !type.elementKey) {
        throw invalidPath(index, 'element segment requires an array with elementKey');
      }
      if (type.element.kind !== 'struct') {
        throw invalidPath(index, 'stable array elements must use a struct schema');
      }
      const keyField = findField(type.element.fields, type.elementKey);
      if (!keyField) {
        throw invalidPath(index, `array elementKey "${type.elementKey}" is invalid`);
      }
      const matches = cursor
        .map((entry, entryIndex) =>
          isRecord(entry) && String(entry[keyField.name]) === segment.key ? entryIndex : -1
        )
        .filter((entryIndex) => entryIndex >= 0);
      if (matches.length > 1) {
        throw invalidPath(index, `duplicate stable element key "${segment.key}"`);
      }
      const elementIndex = matches[0];
      if (elementIndex === undefined) {
        throw invalidPath(index, `stable element key "${segment.key}" was not found`);
      }
      if (last) {
        cursor[elementIndex] = cloneUnknown(replacement);
        return;
      }
      cursor = cursor[elementIndex];
      type = type.element;
      return;
    }
    if (type.kind !== 'map' || !isRecord(cursor)) {
      throw invalidPath(index, 'map segment requires a map value');
    }
    if (last) {
      cursor[segment.key] = cloneUnknown(replacement);
      return;
    }
    if (!Object.hasOwn(cursor, segment.key)) {
      throw invalidPath(index, `map key "${segment.key}" was not found`);
    }
    cursor = cursor[segment.key];
    type = type.value;
  });

  const validation = schema.validate(cloned);
  if (!validation.ok) {
    throw new Error(
      `Prefab override result failed schema validation: ${validation.issues
        .map((issue) => issue.message)
        .join('; ')}`
    );
  }
  return cloneUnknown(validation.value) as T;
}

function findField(fields: readonly FieldSchema[], id: string): FieldSchema | undefined {
  return fields.find((field) => String(field.id) === String(id));
}

function invalidPath(index: number, reason: string): Error {
  return new Error(`Invalid Prefab override segment ${index}: ${reason}.`);
}

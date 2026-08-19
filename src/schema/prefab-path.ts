import { cloneUnknown } from './migration';
import type {
  FieldSchema,
  FieldId,
  PrefabOverridePath,
  PrefabOverridePathDefinition,
  PrefabPathSegment,
  TypeSchema,
  ValueType
} from './types';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

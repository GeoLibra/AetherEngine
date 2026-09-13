import { isRecord } from '../core';
import { cloneUnknown } from './utils';
import type {
  DocumentReference,
  FieldSchema,
  ReferenceMapper,
  ReferencePathSegment,
  ReferenceVisit,
  ReferenceVisitor,
  TypeSchema,
  ValueType
} from './types';

/**
 * Traverses all entity and asset references declared in a schema-typed value and invokes a visitor callback.
 *
 * Supports arbitrary nesting within structs, arrays, and maps.
 *
 * @typeParam T - The typed schema value.
 * @param schema - The schema describing field layouts and reference policies.
 * @param value - The value instance to inspect.
 * @param visitor - The callback invoked for each detected reference.
 */
export function visitSchemaReferences<T>(
  schema: TypeSchema<T>,
  value: T,
  visitor: ReferenceVisitor
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const field of schema.fields) {
    visitValue(schema, field.type, value[field.name], [fieldPath(field)], visitor);
  }
}

/**
 * Traverses and remaps all entity and asset references within a schema-typed value.
 *
 * Returns a cloned copy of `value` with updated references. If a required reference mapper returns `null`,
 * an error is thrown.
 *
 * @typeParam T - The typed schema value.
 * @param schema - The schema describing field layouts and reference policies.
 * @param value - The value instance containing references to remap.
 * @param mapper - The transformation callback invoked for each reference.
 * @returns A structurally cloned value with remapped references.
 * @throws {Error} If a required reference is cleared (`null` returned) or reference kind changes.
 */
export function mapSchemaReferences<T>(
  schema: TypeSchema<T>,
  value: T,
  mapper: ReferenceMapper
): T {
  const cloned = cloneUnknown(value);
  if (!isRecord(cloned)) {
    return cloned as T;
  }
  for (const field of schema.fields) {
    if (Object.hasOwn(cloned, field.name)) {
      cloned[field.name] = mapValue(
        schema,
        field.type,
        cloned[field.name],
        [fieldPath(field)],
        mapper
      );
    }
  }
  return cloned as T;
}

function visitValue<T>(
  schema: TypeSchema<T>,
  type: ValueType,
  value: unknown,
  path: readonly ReferencePathSegment[],
  visitor: ReferenceVisitor
): void {
  if (type.kind === 'entity-ref' || type.kind === 'asset-ref') {
    const reference = readReference(type, value);
    if (reference) {
      visitor(createVisit(schema, path, type.policy, reference, expectedType(type, reference)));
    }
    return;
  }
  if (type.kind === 'array' && Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitValue(schema, type.element, entry, [...path, arrayPath(index)], visitor)
    );
    return;
  }
  if (type.kind === 'map' && isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      visitValue(schema, type.value, entry, [...path, mapPath(key)], visitor);
    }
    return;
  }
  if (type.kind === 'struct' && isRecord(value)) {
    for (const field of type.fields) {
      visitValue(schema, field.type, value[field.name], [...path, fieldPath(field)], visitor);
    }
  }
}

function mapValue<T>(
  schema: TypeSchema<T>,
  type: ValueType,
  value: unknown,
  path: readonly ReferencePathSegment[],
  mapper: ReferenceMapper
): unknown {
  if (type.kind === 'entity-ref' || type.kind === 'asset-ref') {
    const reference = readReference(type, value);
    return reference ? mapReference(schema, type, path, reference, mapper) : value;
  }
  if (type.kind === 'array' && Array.isArray(value)) {
    return value.map((entry, index) =>
      mapValue(schema, type.element, entry, [...path, arrayPath(index)], mapper)
    );
  }
  if (type.kind === 'map' && isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      value[key] = mapValue(schema, type.value, entry, [...path, mapPath(key)], mapper);
    }
    return value;
  }
  if (type.kind === 'struct' && isRecord(value)) {
    for (const field of type.fields) {
      if (Object.hasOwn(value, field.name)) {
        value[field.name] = mapValue(
          schema,
          field.type,
          value[field.name],
          [...path, fieldPath(field)],
          mapper
        );
      }
    }
  }
  return value;
}

function mapReference<T>(
  schema: TypeSchema<T>,
  type: Extract<ValueType, { kind: 'entity-ref' | 'asset-ref' }>,
  path: readonly ReferencePathSegment[],
  reference: DocumentReference,
  mapper: ReferenceMapper
): DocumentReference | null {
  const mapped = mapper(
    createVisit(schema, path, type.policy, reference, expectedType(type, reference))
  );
  if (mapped === null) {
    if (type.policy === 'required') {
      throw new Error(
        `Cannot clear required reference at schema field path "${formatPath(path)}".`
      );
    }
    return null;
  }
  const expectedKind = type.kind === 'entity-ref' ? 'entity' : 'asset';
  if (mapped.kind !== expectedKind) {
    throw new Error(
      `Reference mapper returned ${mapped.kind} for ${expectedKind} field path "${formatPath(path)}".`
    );
  }
  return mapped;
}

function formatPath(path: readonly ReferencePathSegment[]): string {
  return path
    .map((segment) => {
      switch (segment.kind) {
        case 'field':
          return String(segment.id);
        case 'array':
          return `[${segment.index}]`;
        case 'map':
          return segment.key;
      }
    })
    .join('.');
}

function readReference(
  type: Extract<ValueType, { kind: 'entity-ref' | 'asset-ref' }>,
  value: unknown
): DocumentReference | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return undefined;
  }
  if (type.kind === 'entity-ref' && value.kind === 'entity') {
    return { kind: 'entity', id: value.id };
  }
  if (type.kind === 'asset-ref' && value.kind === 'asset') {
    return typeof value.expectedType !== 'string'
      ? { kind: 'asset', id: value.id }
      : { kind: 'asset', id: value.id, expectedType: value.expectedType };
  }
  return undefined;
}

function createVisit<T>(
  schema: TypeSchema<T>,
  path: readonly ReferencePathSegment[],
  policy: ReferenceVisit['policy'],
  reference: DocumentReference,
  expectedType: string | undefined
): ReferenceVisit {
  return Object.freeze({
    schema: schema.id,
    path: Object.freeze([...path]),
    policy,
    reference: Object.freeze(reference),
    ...(expectedType === undefined ? {} : { expectedType })
  });
}

function expectedType(
  type: Extract<ValueType, { kind: 'entity-ref' | 'asset-ref' }>,
  reference: DocumentReference
): string | undefined {
  if (type.kind !== 'asset-ref' || reference.kind !== 'asset') {
    return undefined;
  }
  return reference.expectedType ?? type.expectedType;
}

function fieldPath(field: FieldSchema): ReferencePathSegment {
  return Object.freeze({ kind: 'field', id: field.id });
}

function arrayPath(index: number): ReferencePathSegment {
  return Object.freeze({ kind: 'array', index });
}

function mapPath(key: string): ReferencePathSegment {
  return Object.freeze({ kind: 'map', key });
}

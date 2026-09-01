import { compareCodeUnits, isRecord } from '../core';
import { defineSchema } from '../schema';
import type { FieldId, ValueTypeDefinition } from '../schema/types';
import { MaterialDiagnosticError } from './diagnostics';
import type {
  MaterialField,
  MaterialFieldDefinition,
  MaterialFieldDefinitions,
  MaterialFieldIndex,
  MaterialSchema,
  MaterialValue,
  MaterialValueType
} from './types';

const SCHEMA_INTERNALS = new WeakMap<object, MaterialSchemaInternals>();
const FIELD_INTERNALS = new WeakMap<object, MaterialFieldInternals>();

interface MaterialSchemaInternals {
  readonly owner: symbol;
  readonly definitions: readonly Readonly<MaterialFieldDefinition>[];
  readonly fieldsById: ReadonlyMap<string, MaterialField>;
}

interface MaterialFieldInternals {
  readonly owner: symbol;
  readonly fingerprint: string;
}

export function defineMaterialSchema<const D extends MaterialFieldDefinitions>(
  definition: Readonly<{ id: string; version: number; fields: D }>
): MaterialSchema<D> {
  const owner = Symbol(definition.id);
  const activeNames = new Set<string>();
  const authoringNames = new Set<string>();
  const fieldIds = new Set<string>();
  const definitions = Object.values(definition.fields).map((field) => snapshotDefinition(field));

  for (const field of definitions) {
    validateIdentity(definition, field, activeNames, fieldIds);
  }
  for (const field of definitions) {
    registerAuthoringNames(definition, field, activeNames, authoringNames);
    assertMaterialValue(definition, field, field.defaultValue);
  }

  const fingerprint = createFingerprint(definitions);
  const fieldEntries = Object.entries(definition.fields).map(([key], index) => {
    const field = definitions[index];
    if (field === undefined) throw new Error('Material field definition order changed.');
    const token = Object.freeze({
      fieldId: field.fieldId as FieldId,
      index: index as MaterialFieldIndex,
      name: field.name,
      schemaId: definition.id,
      schemaVersion: definition.version,
      valueType: field.valueType,
      bindingPath: field.bindingPath
    }) as MaterialField;
    FIELD_INTERNALS.set(token, { owner, fingerprint });
    return [key, token] as const;
  });
  const fields = Object.freeze(Object.fromEntries(fieldEntries));
  const fieldsByName = new Map<string, MaterialField>();
  const fieldsById = new Map<string, MaterialField>();

  definitions.forEach((field, index) => {
    const token = fieldEntries[index]?.[1];
    if (token === undefined) throw new Error('Material field token is missing.');
    fieldsByName.set(field.name, token);
    for (const alias of field.aliases ?? []) fieldsByName.set(alias, token);
    fieldsById.set(field.fieldId, token);
  });

  const typeSchema = defineSchema<Readonly<Record<string, MaterialValue>>>({
    id: definition.id,
    version: definition.version,
    kind: 'asset',
    fields: definitions.map((field) => ({
      id: field.fieldId,
      name: field.name,
      type: toSharedValueType(field.valueType),
      required: true,
      defaultValue: field.defaultValue,
      compare: isScalar(field.valueType) ? 'exact' : 'shallow',
      serialization: 'save'
    })),
    validate(input) {
      if (!isRecord(input)) {
        return { ok: false, issues: [{ path: [], message: 'Expected a material record.' }] };
      }
      const issues = definitions.flatMap((field) =>
        isMaterialValue(input[field.name], field.valueType)
          ? []
          : [{ path: [field.name], message: `Invalid material field "${field.name}".` }]
      );
      return issues.length === 0
        ? { ok: true, value: input as Readonly<Record<string, MaterialValue>> }
        : { ok: false, issues };
    }
  });

  let schema: MaterialSchema<D>;
  schema = Object.freeze({
    id: typeSchema.id,
    version: typeSchema.version,
    fingerprint,
    fields,
    typeSchema,
    field(name: string): MaterialField<MaterialValue> {
      const field = fieldsByName.get(name);
      if (field !== undefined) return field;
      throw diagnostic(definition, 'unknown-field', name, `Unknown material field "${name}".`);
    },
    tryField(name: string): MaterialField<MaterialValue> | null {
      return fieldsByName.get(name) ?? null;
    }
  }) as unknown as MaterialSchema<D>;
  SCHEMA_INTERNALS.set(schema, {
    owner,
    definitions: Object.freeze(definitions),
    fieldsById
  });
  return schema;
}

export function getMaterialSchemaInternals(schema: MaterialSchema): MaterialSchemaInternals {
  const internals = SCHEMA_INTERNALS.get(schema);
  if (internals === undefined) throw new Error('Unrecognized material schema.');
  return internals;
}

export function getMaterialFieldInternals<T extends MaterialValue>(
  field: MaterialField<T>
): MaterialFieldInternals | undefined {
  return FIELD_INTERNALS.get(field);
}

export function isMaterialValue(value: unknown, type: MaterialValueType): value is MaterialValue {
  switch (type.kind) {
    case 'number':
      return isFormattedNumber(value, type.format);
    case 'boolean':
      return typeof value === 'boolean';
    case 'vector':
      return isNumericArray(value, type.length, type.format);
    case 'matrix':
      return isNumericArray(value, type.columns * type.rows, 'f32');
    case 'array':
      return (
        Array.isArray(value) &&
        value.length === type.length &&
        value.every((entry) => isMaterialValue(entry, type.element))
      );
    case 'texture-reference':
      return isReference(value, 'texture');
    case 'sampler-reference':
      return isReference(value, 'sampler');
  }
}

function validateIdentity(
  schema: Readonly<{ id: string; version: number }>,
  field: Readonly<MaterialFieldDefinition>,
  activeNames: Set<string>,
  fieldIds: Set<string>
): void {
  if (fieldIds.has(field.fieldId) || activeNames.has(field.name)) {
    throw diagnostic(
      schema,
      'duplicate-field',
      field.name,
      `Material schema "${schema.id}" has a duplicate field id or active name.`
    );
  }
  fieldIds.add(field.fieldId);
  activeNames.add(field.name);
}

function registerAuthoringNames(
  schema: Readonly<{ id: string; version: number }>,
  field: Readonly<MaterialFieldDefinition>,
  activeNames: ReadonlySet<string>,
  authoringNames: Set<string>
): void {
  authoringNames.add(field.name);
  for (const alias of field.aliases ?? []) {
    if (alias.trim() === '' || activeNames.has(alias) || authoringNames.has(alias)) {
      throw diagnostic(
        schema,
        'invalid-alias',
        field.name,
        `Material field alias "${alias}" collides with another authoring name.`
      );
    }
    authoringNames.add(alias);
  }
}

function assertMaterialValue(
  schema: Readonly<{ id: string; version: number }>,
  field: Readonly<MaterialFieldDefinition>,
  value: unknown
): asserts value is MaterialValue {
  if (!isMaterialValue(value, field.valueType)) {
    throw diagnostic(
      schema,
      'type-mismatch',
      field.name,
      `Material field "${field.name}" value does not match its declared type.`
    );
  }
}

function snapshotDefinition(
  field: Readonly<MaterialFieldDefinition>
): Readonly<MaterialFieldDefinition> {
  return Object.freeze({
    ...field,
    ...(field.aliases === undefined ? {} : { aliases: Object.freeze([...field.aliases]) }),
    valueType: freezeValueType(field.valueType),
    defaultValue: freezeValue(cloneValue(field.defaultValue))
  });
}

function freezeValueType(type: MaterialValueType): MaterialValueType {
  if (type.kind === 'array') {
    return Object.freeze({ ...type, element: freezeValueType(type.element) });
  }
  return Object.freeze({ ...type });
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])
    ) as T;
  }
  return value;
}

function freezeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => freezeValue(entry));
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => freezeValue(entry));
    return Object.freeze(value) as T;
  }
  return value;
}

function createFingerprint(fields: readonly Readonly<MaterialFieldDefinition>[]): string {
  const canonical = fields
    .map((field) => [field.fieldId, canonicalType(field.valueType), field.bindingPath] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return `material-schema-v1:${JSON.stringify(canonical)}`;
}

function canonicalType(type: MaterialValueType): unknown {
  return type.kind === 'array'
    ? { kind: type.kind, length: type.length, element: canonicalType(type.element) }
    : Object.fromEntries(
        Object.entries(type).sort(([left], [right]) => compareCodeUnits(left, right))
      );
}

export { compareCodeUnits };

function toSharedValueType(type: MaterialValueType): ValueTypeDefinition {
  switch (type.kind) {
    case 'number':
    case 'boolean':
    case 'vector':
      return type;
    case 'matrix':
      return { kind: 'matrix', columns: type.columns, rows: type.rows };
    case 'array':
      return { kind: 'array', element: toSharedValueType(type.element) };
    case 'texture-reference':
      return referenceStructType('texture');
    case 'sampler-reference':
      return referenceStructType('sampler');
  }
}

function referenceStructType(kind: 'texture' | 'sampler'): ValueTypeDefinition {
  return {
    kind: 'struct',
    fields: [
      {
        id: 'kind',
        name: 'kind',
        type: { kind: 'enum', values: [kind] },
        required: true,
        compare: 'exact',
        serialization: 'save'
      },
      {
        id: 'asset-id',
        name: 'assetId',
        type: { kind: 'string' },
        required: true,
        compare: 'exact',
        serialization: 'save'
      }
    ]
  };
}

function isScalar(type: MaterialValueType): boolean {
  return type.kind === 'number' || type.kind === 'boolean';
}

function isFormattedNumber(value: unknown, format: 'f32' | 'i32' | 'u32'): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (format === 'i32') {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  }
  if (format === 'u32') {
    return Number.isInteger(value) && value >= 0 && value <= 4294967295;
  }
  return Number.isFinite(Math.fround(value));
}

function isNumericArray(
  value: unknown,
  length: number,
  format: 'f32' | 'i32' | 'u32'
): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => isFormattedNumber(entry, format))
  );
}

function isReference(value: unknown, kind: 'texture' | 'sampler'): boolean {
  return isRecord(value) && value.kind === kind && typeof value.assetId === 'string';
}

function diagnostic(
  schema: Readonly<{ id: string; version: number }>,
  code: 'unknown-field' | 'type-mismatch' | 'duplicate-field' | 'invalid-alias',
  field: string,
  message: string
): MaterialDiagnosticError {
  return new MaterialDiagnosticError({
    code,
    schemaId: schema.id,
    schemaVersion: schema.version,
    field,
    message
  });
}

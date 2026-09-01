import { cloneUnknown, freezeUnknown, isRecord } from './utils';
import type {
  DecodedSchemaPayload,
  KnownSchemaPayload,
  SchemaPayload,
  TypeSchema,
  ValidationIssue
} from './types';

/**
 * Error thrown when a payload violates schema validation rules or is missing required fields.
 */
export class SchemaValidationError extends Error {
  readonly code = 'schema/validation-failed';

  constructor(
    readonly schema: string,
    readonly version: number,
    readonly issues: readonly ValidationIssue[]
  ) {
    super(`Schema "${schema}" version ${version} validation failed.`);
  }
}

/**
 * Decodes a raw `SchemaPayload` into a strongly typed `KnownSchemaPayload<T>`.
 *
 * Populates missing optional fields with their defined defaults, validates required fields,
 * runs the schema's runtime validator, and preserves unknown fields in the `extensions` bag
 * to enable lossless round-trip serialization.
 *
 * @typeParam T - The decoded value type.
 * @param schema - The target type schema to decode against.
 * @param payload - The raw payload containing serialized fields.
 * @returns The decoded and frozen known payload.
 * @throws {SchemaValidationError} If required fields are missing or schema validation fails.
 */
export function decodeKnownPayload<T>(
  schema: TypeSchema<T>,
  payload: SchemaPayload
): KnownSchemaPayload<T> {
  const input: Record<string, unknown> = {};
  const extensions: Record<string, unknown> = {};
  const knownFieldIds = new Set(schema.fields.map((field) => String(field.id)));
  const issues: ValidationIssue[] = [];

  for (const field of schema.fields) {
    const id = String(field.id);
    if (Object.hasOwn(payload.fields, id)) {
      input[field.name] = cloneUnknown(payload.fields[id]);
    } else if (field.defaultValue !== undefined) {
      input[field.name] = cloneUnknown(field.defaultValue);
    } else if (field.required) {
      issues.push({ path: [id], message: `Required field "${id}" is missing.` });
    }
  }
  for (const [id, value] of Object.entries(payload.fields)) {
    if (!knownFieldIds.has(id)) {
      extensions[id] = cloneUnknown(value);
    }
  }
  if (issues.length > 0) {
    throw new SchemaValidationError(schema.id, schema.version, Object.freeze(issues));
  }

  const validation = schema.validate(freezeUnknown(input));
  if (!validation.ok) {
    throw new SchemaValidationError(schema.id, schema.version, validation.issues);
  }
  return Object.freeze({
    kind: 'known',
    schema,
    value: freezeUnknown(cloneUnknown(validation.value)) as T,
    extensions: freezeUnknown(extensions)
  });
}

/**
 * Encodes a `DecodedSchemaPayload` back into a raw `SchemaPayload`.
 *
 * Only fields with `serialization === 'save'` are exported, and all preserved `extensions`
 * are merged back into the serialized output.
 *
 * @typeParam T - The value type.
 * @param decoded - The decoded schema payload (either known or opaque).
 * @returns An immutable, frozen raw schema payload.
 */
export function encodeDecodedPayload<T>(decoded: DecodedSchemaPayload<T>): SchemaPayload {
  if (decoded.kind === 'opaque') {
    return freezePayload(decoded.payload);
  }

  const fields = cloneUnknown(decoded.extensions) as Record<string, unknown>;
  const value = decoded.value as Record<string, unknown>;
  for (const field of decoded.schema.fields) {
    if (field.serialization !== 'save') {
      continue;
    }
    if (Object.hasOwn(value, field.name)) {
      fields[String(field.id)] = cloneUnknown(value[field.name]);
    }
  }
  return freezePayload({
    schema: decoded.schema.id,
    version: decoded.schema.version,
    fields
  });
}

/**
 * Validates the structure of a `SchemaPayload` and returns a deeply frozen copy.
 *
 * @param payload - The payload to validate and freeze.
 * @returns The frozen payload.
 * @throws {Error} If schema name is invalid, version is non-positive, or fields is not an object.
 */
export function freezePayload(payload: SchemaPayload): SchemaPayload {
  if (
    typeof payload.schema !== 'string' ||
    !Number.isInteger(payload.version) ||
    payload.version <= 0 ||
    !isRecord(payload.fields)
  ) {
    throw new Error('Schema payload must contain schema, positive version, and record fields.');
  }
  return Object.freeze({
    schema: payload.schema,
    version: payload.version,
    fields: freezeUnknown(cloneUnknown(payload.fields) as Record<string, unknown>)
  });
}

import { cloneUnknown, freezeUnknown } from './migration';
import type {
  DecodedSchemaPayload,
  KnownSchemaPayload,
  SchemaPayload,
  TypeSchema,
  ValidationIssue
} from './types';

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

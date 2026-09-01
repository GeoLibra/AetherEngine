import type { TypeSchema } from './definition';

/**
 * Raw serialized payload representing component or resource data in transport/storage.
 */
export interface SchemaPayload {
  readonly schema: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Successfully decoded payload recognized by the active `SchemaRegistry`.
 * Unrecognized fields are preserved in `extensions` for round-trip safety.
 */
export interface KnownSchemaPayload<T> {
  readonly kind: 'known';
  readonly schema: TypeSchema<T>;
  readonly value: T;
  readonly extensions: Readonly<Record<string, unknown>>;
}

/**
 * Opaque payload preserved when a schema is unknown to the active registry (e.g. missing plugin).
 * Retained for lossless round-trip serialization in editor workflows.
 */
export interface OpaqueSchemaPayload {
  readonly kind: 'opaque';
  readonly payload: SchemaPayload;
}

/**
 * Discriminated union of decoded payload results.
 */
export type DecodedSchemaPayload<T = unknown> = KnownSchemaPayload<T> | OpaqueSchemaPayload;

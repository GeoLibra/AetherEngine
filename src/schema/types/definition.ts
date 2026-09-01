import type { SchemaId, SchemaKind, SchemaStorage, SchemaVersion } from './identity';
import type { FieldDefinition, FieldSchema } from './fields';
import type { ValidationResult } from './validation';

/**
 * Immutable compiled type schema contract for components, resources, assets, or documents.
 */
export interface TypeSchema<T> {
  readonly id: SchemaId;
  readonly version: SchemaVersion;
  readonly kind: SchemaKind;
  readonly storage?: SchemaStorage;
  readonly fields: readonly FieldSchema[];
  readonly validate: (input: unknown) => ValidationResult<T>;
  readonly __valueType?: T;
}

/**
 * Authoring definition format used to construct a `TypeSchema<T>` via `defineSchema()`.
 */
export interface SchemaDefinition<T> {
  readonly id: string;
  readonly version: number;
  readonly kind: SchemaKind;
  readonly storage?: SchemaStorage;
  readonly fields: readonly FieldDefinition[];
  readonly validate: (input: unknown) => ValidationResult<T>;
}

/**
 * Handle returned upon registering a schema into `SchemaRegistry`.
 */
export interface SchemaRegistration<T> {
  readonly schema: TypeSchema<T>;
  readonly typeIndex: number;
  remove(): boolean;
}

/**
 * Consumer perspective kind for schema view derivation.
 */
export type SchemaViewKind = 'serialization' | 'editor' | 'replication';

/**
 * Specialized field projection derived from a `TypeSchema<T>` for a specific consumer subsystem.
 */
export interface SchemaView<T> {
  readonly kind: SchemaViewKind;
  readonly schema: TypeSchema<T>;
  readonly typeIndex: number;
  readonly fields: readonly FieldSchema[];
}

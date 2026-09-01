/**
 * Branded nominal type for a namespaced, stable schema identifier.
 * Example: `aether.transform.local`
 */
export type SchemaId = string & { readonly __schemaId: unique symbol };

/**
 * Branded nominal type for a positive integer schema version.
 */
export type SchemaVersion = number & { readonly __schemaVersion: unique symbol };

/**
 * Branded nominal type for a stable field identifier.
 * Stable across TypeScript property renames or display label changes.
 */
export type FieldId = string & { readonly __fieldId: unique symbol };

/**
 * Declares the architectural role of a schema.
 */
export type SchemaKind = 'component' | 'resource' | 'asset' | 'document' | 'command';

/**
 * Declares the storage strategy for ECS component schemas:
 * - `packed`: Stored in contiguous typed arrays for high cache locality (fixed-size numeric/vector/matrix only).
 * - `object`: Stored as normal JavaScript objects in object pools.
 * - `tag`: Pure zero-sized marker with no fields, contributing only to archetype signatures.
 */
export type SchemaStorage = 'packed' | 'object' | 'tag';

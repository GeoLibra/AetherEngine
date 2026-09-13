export { FIELD_ID_PATTERN, SCHEMA_ID_PATTERN } from './constants';
export { defineSchema } from './definition';
export { SchemaValidationError } from './payload';
export { applyPrefabOverride, createPrefabOverridePath } from './prefab-path';
export { ReferenceResolutionError } from './reference-transaction';
export { mapSchemaReferences, visitSchemaReferences } from './references';
export { SchemaRegistry, SchemaRegistryResource } from './registry';
export { cloneRecord, cloneUnknown, freezeRecord, freezeUnknown } from './utils';

export type {
  DecodedSchemaPayload,
  DocumentReference,
  EditorHint,
  FieldComparison,
  FieldDefinition,
  FieldId,
  FieldSchema,
  FieldSerialization,
  KnownSchemaPayload,
  MigrationResult,
  MigrationStepResult,
  MigrationWarning,
  OpaqueSchemaPayload,
  PrefabOverridePath,
  PrefabOverridePathDefinition,
  PrefabPathSegment,
  ReferenceMapper,
  ReferencePathSegment,
  ReferencePolicy,
  ReferenceResolutionIssue,
  ReferenceResolver,
  ReferenceTransactionEntry,
  ReferenceVisit,
  ReferenceVisitor,
  ReplicationPolicy,
  ResolvedReferenceEntry,
  SchemaDefinition,
  SchemaId,
  SchemaKind,
  SchemaMigration,
  SchemaMigrationRegistration,
  SchemaPayload,
  SchemaRegistration,
  SchemaStorage,
  SchemaVersion,
  SchemaView,
  SchemaViewKind,
  TypeSchema,
  ValidationIssue,
  ValidationResult,
  ValueType,
  ValueTypeDefinition
} from './types';

export type SchemaId = string & { readonly __schemaId: unique symbol };
export type SchemaVersion = number & { readonly __schemaVersion: unique symbol };
export type FieldId = string & { readonly __fieldId: unique symbol };

export type SchemaKind = 'component' | 'resource' | 'asset' | 'document' | 'command';
export type SchemaStorage = 'packed' | 'object' | 'tag';
export type FieldComparison = 'identity' | 'exact' | 'epsilon' | 'shallow';
export type FieldSerialization = 'save' | 'runtime-only' | 'editor-only';
export type ReferencePolicy = 'required' | 'optional' | 'soft';

export type ValueType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly format: 'f32' | 'f64' | 'i32' | 'u32' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'vector'; readonly length: 2 | 3 | 4 }
  | { readonly kind: 'matrix'; readonly columns: 2 | 3 | 4; readonly rows: 2 | 3 | 4 }
  | { readonly kind: 'array'; readonly element: ValueType }
  | { readonly kind: 'map'; readonly value: ValueType }
  | { readonly kind: 'struct'; readonly fields: readonly FieldSchema[] }
  | { readonly kind: 'entity-ref'; readonly policy: ReferencePolicy }
  | {
      readonly kind: 'asset-ref';
      readonly policy: ReferencePolicy;
      readonly expectedType?: string;
    };

export type ValueTypeDefinition =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly format: 'f32' | 'f64' | 'i32' | 'u32' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'vector'; readonly length: 2 | 3 | 4 }
  | { readonly kind: 'matrix'; readonly columns: 2 | 3 | 4; readonly rows: 2 | 3 | 4 }
  | { readonly kind: 'array'; readonly element: ValueTypeDefinition }
  | { readonly kind: 'map'; readonly value: ValueTypeDefinition }
  | { readonly kind: 'struct'; readonly fields: readonly FieldDefinition[] }
  | { readonly kind: 'entity-ref'; readonly policy: ReferencePolicy }
  | {
      readonly kind: 'asset-ref';
      readonly policy: ReferencePolicy;
      readonly expectedType?: string;
    };

export interface EditorHint {
  readonly label?: string;
  readonly widget?:
    | 'number'
    | 'slider'
    | 'vector'
    | 'rotation'
    | 'color'
    | 'asset'
    | 'enum';
  readonly range?: readonly [number, number];
  readonly step?: number;
  readonly group?: string;
  readonly readOnly?: boolean;
}

export interface ReplicationPolicy {
  readonly authority: 'server' | 'owner' | 'shared';
  readonly reliability: 'reliable' | 'unreliable';
  readonly frequency?: number;
  readonly quantization?: number;
}

export interface FieldSchema {
  readonly id: FieldId;
  readonly name: string;
  readonly type: ValueType;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly compare: FieldComparison;
  readonly serialization: FieldSerialization;
  readonly editor?: EditorHint;
  readonly replication?: ReplicationPolicy;
}

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export interface TypeSchema<T> {
  readonly id: SchemaId;
  readonly version: SchemaVersion;
  readonly kind: SchemaKind;
  readonly storage?: SchemaStorage;
  readonly fields: readonly FieldSchema[];
  readonly validate: (input: unknown) => ValidationResult<T>;
  readonly __valueType?: T;
}

export interface FieldDefinition extends Omit<FieldSchema, 'id' | 'type' | 'editor'> {
  readonly id: string;
  readonly type: ValueTypeDefinition;
  readonly editor?: EditorHint;
}

export interface SchemaDefinition<T> {
  readonly id: string;
  readonly version: number;
  readonly kind: SchemaKind;
  readonly storage?: SchemaStorage;
  readonly fields: readonly FieldDefinition[];
  readonly validate: (input: unknown) => ValidationResult<T>;
}

export interface SchemaRegistration<T> {
  readonly schema: TypeSchema<T>;
  readonly typeIndex: number;
  remove(): boolean;
}

export type SchemaViewKind = 'serialization' | 'editor' | 'replication';

export interface SchemaView<T> {
  readonly kind: SchemaViewKind;
  readonly schema: TypeSchema<T>;
  readonly typeIndex: number;
  readonly fields: readonly FieldSchema[];
}

export interface MigrationWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export interface MigrationStepResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly MigrationWarning[];
}

export interface SchemaMigration {
  readonly schema: string;
  readonly from: number;
  readonly to: number;
  migrate(input: Readonly<Record<string, unknown>>): MigrationStepResult;
}

export interface SchemaMigrationRegistration {
  readonly migration: SchemaMigration;
  remove(): boolean;
}

export interface MigrationResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly warnings: readonly MigrationWarning[];
}

export interface SchemaPayload {
  readonly schema: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface KnownSchemaPayload<T> {
  readonly kind: 'known';
  readonly schema: TypeSchema<T>;
  readonly value: T;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface OpaqueSchemaPayload {
  readonly kind: 'opaque';
  readonly payload: SchemaPayload;
}

export type DecodedSchemaPayload<T = unknown> =
  | KnownSchemaPayload<T>
  | OpaqueSchemaPayload;

export type DocumentReference =
  | { readonly kind: 'entity'; readonly id: string }
  | { readonly kind: 'asset'; readonly id: string; readonly expectedType?: string };

export type ReferencePathSegment =
  | { readonly kind: 'field'; readonly id: FieldId }
  | { readonly kind: 'array'; readonly index: number }
  | { readonly kind: 'map'; readonly key: string };

export interface ReferenceVisit {
  readonly schema: SchemaId;
  readonly path: readonly ReferencePathSegment[];
  readonly policy: ReferencePolicy;
  readonly reference: DocumentReference;
  readonly expectedType?: string;
}

export type ReferenceVisitor = (visit: ReferenceVisit) => void;
export type ReferenceMapper = (visit: ReferenceVisit) => DocumentReference | null;

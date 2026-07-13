import type {
  EditorHint,
  FieldComparison,
  FieldSchema,
  FieldSerialization,
  ReplicationPolicy,
  SchemaDefinition,
  TypeSchema,
  ValueType
} from '../schema';

// Resource constructors are identity tokens only; World never invokes them.
export type ResourceType<T> = abstract new (...args: never[]) => T;

export type Entity = number;

export interface ChangeWindow {
  readonly sinceExclusive: number;
  readonly untilInclusive: number;
}

export interface ChangeReaderOptions {
  readonly from?: 'current' | 'beginning';
}

export interface RemovedComponent<TView extends object = object> {
  readonly entity: Entity;
  readonly component: ComponentType<TView>;
  readonly tick: number;
}

export type ComponentFieldType =
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'ivec3'
  | 'mat3'
  | 'mat4'
  | 'entity';

export interface ComponentFieldDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: ComponentFieldType;
  readonly required?: boolean;
  readonly defaultValue?: unknown;
  readonly compare?: FieldComparison;
  readonly serialization?: FieldSerialization;
  readonly editor?: EditorHint;
  readonly replication?: ReplicationPolicy;
}

export interface ComponentField extends Omit<FieldSchema, 'type'> {
  readonly type: ValueType;
  readonly packedType: ComponentFieldType;
  readonly offset: number;
  readonly size: number;
}

interface BaseComponentSchema<TView extends object> extends TypeSchema<TView> {
  readonly kind: 'component';
  readonly name: string;
}

export interface PackedComponentSchema<TView extends object = Record<string, unknown>>
  extends TypeSchema<TView> {
  readonly kind: 'component';
  readonly storage: 'packed';
  readonly name: string;
  readonly fields: readonly ComponentField[];
  readonly size: number;
}

export interface ObjectComponentSchema<TView extends object = Record<string, unknown>>
  extends BaseComponentSchema<TView> {
  readonly storage: 'object';
}

export interface TagComponentSchema<TView extends object = Record<string, never>>
  extends BaseComponentSchema<TView> {
  readonly storage: 'tag';
  readonly fields: readonly [];
}

export type ComponentSchema<TView extends object = Record<string, unknown>> =
  | PackedComponentSchema<TView>
  | ObjectComponentSchema<TView>
  | TagComponentSchema<TView>;

export type ComponentType<TView extends object = Record<string, unknown>> = ComponentSchema<TView>;

export interface ComponentDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly fields: readonly ComponentFieldDefinition[];
  readonly validate?: TypeSchema<object>['validate'];
}

export interface ObjectComponentDefinition<TView extends object>
  extends Omit<SchemaDefinition<TView>, 'kind' | 'storage'> {
  readonly name: string;
}

export interface TagComponentDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
}

export type ComponentInput = Record<string, unknown>;

export interface RelationType {
  readonly name: string;
  readonly id: symbol;
  readonly key: string;
  readonly acyclic: boolean;
}

export interface RelationOptions {
  readonly acyclic?: boolean;
}

export interface Relation {
  readonly relation: RelationType;
  readonly target: Entity;
}

export type QueryFilterTerm = ComponentType<object> | RelationType;

export interface QueryFilter {
  readonly with?: readonly QueryFilterTerm[];
  readonly without?: readonly QueryFilterTerm[];
  readonly changed?: readonly ComponentType<object>[];
  readonly added?: readonly ComponentType<object>[];
  readonly relation?: readonly [RelationType, Entity];
}

export type QueryViews<TComponents extends readonly ComponentType<object>[]> = {
  [Index in keyof TComponents]: TComponents[Index] extends ComponentType<infer TView> ? TView : never;
};

export type QueryItem<TComponents extends readonly ComponentType<object>[]> = [
  Entity,
  ...QueryViews<TComponents>
];

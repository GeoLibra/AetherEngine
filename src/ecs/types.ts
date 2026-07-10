import type {
  EditorHint,
  FieldComparison,
  FieldSchema,
  FieldSerialization,
  ReplicationPolicy,
  TypeSchema,
  ValueType
} from '../schema';

// Resource constructors are identity tokens only; World never invokes them.
export type ResourceType<T> = abstract new (...args: never[]) => T;

export type Entity = number;

export type ComponentFieldType =
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4'
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

export interface ComponentSchema<TView extends object = Record<string, unknown>>
  extends TypeSchema<TView> {
  readonly kind: 'component';
  readonly storage: 'packed';
  readonly name: string;
  readonly fields: readonly ComponentField[];
  readonly size: number;
}

export type ComponentType<TView extends object = Record<string, unknown>> = ComponentSchema<TView>;

export interface ComponentDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly fields: readonly ComponentFieldDefinition[];
  readonly validate?: TypeSchema<object>['validate'];
}

export type ComponentInput = Record<string, unknown>;

export interface RelationType {
  readonly name: string;
  readonly id: symbol;
  readonly key: string;
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

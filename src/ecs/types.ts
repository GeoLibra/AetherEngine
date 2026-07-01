export type ResourceType<T> = abstract new (...args: unknown[]) => T;

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
  readonly name: string;
  readonly type: ComponentFieldType;
}

export interface ComponentField extends ComponentFieldDefinition {
  readonly offset: number;
  readonly size: number;
}

export interface ComponentSchema<TView extends object = Record<string, unknown>> {
  readonly name: string;
  readonly fields: readonly ComponentField[];
  readonly size: number;
  readonly __viewType?: TView;
}

export type ComponentType<TView extends object = Record<string, unknown>> = ComponentSchema<TView>;

export interface ComponentDefinition {
  readonly name: string;
  readonly fields: readonly ComponentFieldDefinition[];
}

export type ComponentInput = Record<string, unknown>;

export interface RelationType {
  readonly name: string;
  readonly id: symbol;
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

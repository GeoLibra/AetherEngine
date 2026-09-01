import type { FieldId } from './identity';
import type { FieldDefinition, FieldSchema, ReferencePolicy } from './fields';

/**
 * Discriminated union of all supported runtime value types in AetherEngine schemas.
 */
export type ValueType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly format: 'f32' | 'f64' | 'i32' | 'u32' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'vector';
      readonly length: 2 | 3 | 4;
      readonly format?: 'f32' | 'i32' | 'u32';
    }
  | { readonly kind: 'matrix'; readonly columns: 2 | 3 | 4; readonly rows: 2 | 3 | 4 }
  | {
      readonly kind: 'array';
      readonly element: ValueType;
      readonly elementKey?: FieldId;
    }
  | { readonly kind: 'map'; readonly value: ValueType }
  | { readonly kind: 'struct'; readonly fields: readonly FieldSchema[] }
  | { readonly kind: 'entity-ref'; readonly policy: ReferencePolicy }
  | {
      readonly kind: 'asset-ref';
      readonly policy: ReferencePolicy;
      readonly expectedType?: string;
    };

/**
 * Authoring definition format for value types prior to schema freezing and validation.
 */
export type ValueTypeDefinition =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly format: 'f32' | 'f64' | 'i32' | 'u32' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'vector';
      readonly length: 2 | 3 | 4;
      readonly format?: 'f32' | 'i32' | 'u32';
    }
  | { readonly kind: 'matrix'; readonly columns: 2 | 3 | 4; readonly rows: 2 | 3 | 4 }
  | {
      readonly kind: 'array';
      readonly element: ValueTypeDefinition;
      readonly elementKey?: string;
    }
  | { readonly kind: 'map'; readonly value: ValueTypeDefinition }
  | { readonly kind: 'struct'; readonly fields: readonly FieldDefinition[] }
  | { readonly kind: 'entity-ref'; readonly policy: ReferencePolicy }
  | {
      readonly kind: 'asset-ref';
      readonly policy: ReferencePolicy;
      readonly expectedType?: string;
    };

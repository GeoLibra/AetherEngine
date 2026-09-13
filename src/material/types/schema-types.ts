import type { FieldId, SchemaId, SchemaVersion, TypeSchema } from '../../schema/types';

declare const materialFieldIndexBrand: unique symbol;
declare const materialFieldValueBrand: unique symbol;

/** Branded numeric index identifying a field in compiled layout hot-paths. */
export type MaterialFieldIndex = number & {
  readonly [materialFieldIndexBrand]: true;
};

/** Opaque handle to a texture asset referenced by material parameters. */
export interface MaterialTextureReference {
  readonly kind: 'texture';
  readonly assetId: string;
}

/** Opaque handle to a sampler asset referenced by material parameters. */
export interface MaterialSamplerReference {
  readonly kind: 'sampler';
  readonly assetId: string;
}

/** Permissible runtime parameter values in material instances. */
export type MaterialValue =
  | number
  | boolean
  | readonly number[]
  | readonly MaterialValue[]
  | MaterialTextureReference
  | MaterialSamplerReference;

/** Structural type specification for material parameter fields. */
export type MaterialValueType =
  | { readonly kind: 'number'; readonly format: 'f32' | 'i32' | 'u32' }
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'vector';
      readonly length: 2 | 3 | 4;
      readonly format: 'f32' | 'i32' | 'u32';
    }
  | {
      readonly kind: 'matrix';
      readonly columns: 2 | 3 | 4;
      readonly rows: 2 | 3 | 4;
      readonly format?: 'f32';
    }
  | {
      readonly kind: 'array';
      readonly element: MaterialValueType;
      readonly length: number;
    }
  | { readonly kind: 'texture-reference' }
  | { readonly kind: 'sampler-reference' };

/** Conditional type mapping a MaterialValueType descriptor to its TypeScript representation. */
export type MaterialValueFromValueType<T extends MaterialValueType> = T extends {
  readonly kind: 'number';
}
  ? number
  : T extends { readonly kind: 'boolean' }
    ? boolean
    : T extends { readonly kind: 'vector' | 'matrix' }
      ? readonly number[]
      : T extends {
            readonly kind: 'array';
            readonly element: infer E extends MaterialValueType;
          }
        ? readonly MaterialValueFromValueType<E>[]
        : T extends { readonly kind: 'texture-reference' }
          ? MaterialTextureReference
          : T extends { readonly kind: 'sampler-reference' }
            ? MaterialSamplerReference
            : never;

/** Static declaration of a single field within a material schema definition. */
export interface MaterialFieldDefinition<T extends MaterialValueType = MaterialValueType> {
  readonly fieldId: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly valueType: T;
  readonly defaultValue: MaterialValueFromValueType<T>;
  readonly bindingPath: string;
}

/** Map of field names to their respective field definitions. */
export type MaterialFieldDefinitions = Readonly<Record<string, MaterialFieldDefinition>>;

/** Infers the TypeScript value type from a field definition. */
export type MaterialValueFromDefinition<D> =
  D extends MaterialFieldDefinition<infer T> ? MaterialValueFromValueType<T> : never;

/** Strongly-typed token representing a resolved parameter field in a material schema. */
export interface MaterialField<T extends MaterialValue = MaterialValue> {
  readonly fieldId: FieldId;
  readonly index: MaterialFieldIndex;
  readonly name: string;
  readonly schemaId: SchemaId;
  readonly schemaVersion: SchemaVersion;
  readonly valueType: MaterialValueType;
  readonly bindingPath: string;
  readonly [materialFieldValueBrand]?: (value: T) => T;
}

/** Strongly-typed token collection mirroring defined schema field keys. */
export type MaterialFields<D extends MaterialFieldDefinitions> = Readonly<{
  [K in keyof D]: MaterialField<MaterialValueFromDefinition<D[K]>>;
}>;

/** Compiled parameter metadata and token registry for a class of materials. */
export interface MaterialSchema<D extends MaterialFieldDefinitions = MaterialFieldDefinitions> {
  readonly id: SchemaId;
  readonly version: SchemaVersion;
  readonly fingerprint: string;
  readonly fields: MaterialFields<D>;
  readonly typeSchema: TypeSchema<Readonly<Record<string, MaterialValue>>>;
  field(name: string): MaterialField<MaterialValue>;
  tryField(name: string): MaterialField<MaterialValue> | null;
}

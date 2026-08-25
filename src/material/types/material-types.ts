import type { FieldId, SchemaId, SchemaVersion, TypeSchema } from '../../schema/types';
import type { RenderPhaseKind } from '../../rendering/phase';

declare const materialFieldIndexBrand: unique symbol;
declare const materialFieldValueBrand: unique symbol;
declare const materialTechniqueRoleBrand: unique symbol;

export type MaterialFieldIndex = number & {
  readonly [materialFieldIndexBrand]: true;
};

export interface MaterialTextureReference {
  readonly kind: 'texture';
  readonly assetId: string;
}

export interface MaterialSamplerReference {
  readonly kind: 'sampler';
  readonly assetId: string;
}

export type MaterialValue =
  | number
  | boolean
  | readonly number[]
  | readonly MaterialValue[]
  | MaterialTextureReference
  | MaterialSamplerReference;

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

export interface MaterialFieldDefinition<T extends MaterialValueType = MaterialValueType> {
  readonly fieldId: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly valueType: T;
  readonly defaultValue: MaterialValueFromValueType<T>;
  readonly bindingPath: string;
}

export type MaterialFieldDefinitions = Readonly<Record<string, MaterialFieldDefinition>>;

export type MaterialValueFromDefinition<D> =
  D extends MaterialFieldDefinition<infer T> ? MaterialValueFromValueType<T> : never;

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

export type MaterialFields<D extends MaterialFieldDefinitions> = Readonly<{
  [K in keyof D]: MaterialField<MaterialValueFromDefinition<D[K]>>;
}>;

export interface MaterialSchema<D extends MaterialFieldDefinitions = MaterialFieldDefinitions> {
  readonly id: SchemaId;
  readonly version: SchemaVersion;
  readonly fingerprint: string;
  readonly fields: MaterialFields<D>;
  readonly typeSchema: TypeSchema<Readonly<Record<string, MaterialValue>>>;
  field(name: string): MaterialField<MaterialValue>;
  tryField(name: string): MaterialField<MaterialValue> | null;
}

export type MaterialEditDiagnosticCode =
  | 'unknown-field'
  | 'type-mismatch'
  | 'schema-mismatch'
  | 'stale-field'
  | 'duplicate-field'
  | 'invalid-alias'
  | 'incompatible-asset';

export type MaterialBindingDiagnosticCode =
  | 'missing-resource'
  | 'resource-not-ready'
  | 'binding-kind-mismatch'
  | 'texture-dimension-mismatch'
  | 'texture-sample-type-mismatch'
  | 'texture-multisample-mismatch'
  | 'sampler-type-mismatch'
  | 'device-generation-mismatch';

export type MaterialTechniqueDiagnosticCode =
  | 'no-compatible-technique'
  | 'undeclared-fallback'
  | 'render-state-conflict'
  | 'missing-binding'
  | 'compile-failure';

export type MaterialDiagnosticCode =
  MaterialEditDiagnosticCode | MaterialBindingDiagnosticCode | MaterialTechniqueDiagnosticCode;

export interface MaterialDiagnostic {
  readonly code: MaterialDiagnosticCode;
  readonly materialId?: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly field?: string;
  readonly message: string;
}

export interface MaterialMetrics {
  readonly blocksCloned: number;
  readonly valuesSnapshotted: number;
}

export interface MaterialParameterBlock {
  readonly schemaId: SchemaId;
  readonly schemaVersion: SchemaVersion;
  readonly fingerprint: string;
  get<T extends MaterialValue>(field: MaterialField<T>): T;
  with<T extends MaterialValue>(field: MaterialField<T>, value: T): MaterialParameterBlock;
  getByName(name: string): MaterialValue;
  withName(name: string, value: MaterialValue): MaterialParameterBlock;
}

export interface MaterialParameterDraft {
  set<T extends MaterialValue>(field: MaterialField<T>, value: T): void;
  setName(name: string, value: MaterialValue): void;
  setKeyword(name: string, value: boolean | string | number): void;
  removeKeyword(name: string): void;
}

export interface MaterialAssetReference {
  readonly assetId: string;
  readonly payloadVersion: number;
}

export type MaterialTechniqueRole = string & {
  readonly [materialTechniqueRoleBrand]: true;
};

export interface MaterialShaderEntryRef {
  readonly moduleKey: string;
  readonly vertexEntry: string;
  readonly fragmentEntry?: string;
}

export interface MaterialTechniqueCompatibility {
  readonly semanticTag: string;
  readonly bindingLayoutHash: string;
  readonly requiredFeatures: readonly string[];
  readonly requiredMaterialFeatures: readonly string[];
  readonly requiredViewFeatures: readonly string[];
  readonly requiredMeshCapabilities: readonly string[];
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormats: readonly string[];
  readonly sampleCounts: readonly number[];
}

export type MaterialSurfaceKind = 'opaque' | 'alpha-mask' | 'transparent';
export type MaterialCullMode = 'none' | 'front' | 'back';

export interface MaterialBlendIntent {
  readonly color: string;
  readonly alpha: string;
}

export interface MaterialRenderStateIntent {
  readonly surface?: MaterialSurfaceKind;
  readonly depthTest?: boolean;
  readonly depthWrite?: boolean;
  readonly colorWrite?: boolean;
  readonly cullMode?: MaterialCullMode;
  readonly blend?: MaterialBlendIntent;
}

export interface MaterialRenderStateOverride {
  readonly depthTest?: boolean;
  readonly depthWrite?: boolean;
  readonly colorWrite?: boolean;
  readonly cullMode?: MaterialCullMode;
  readonly blend?: MaterialBlendIntent;
}

export interface MaterialTechnique {
  readonly name: string;
  readonly passRole: MaterialTechniqueRole;
  readonly shader: MaterialShaderEntryRef;
  readonly renderStateOverride?: MaterialRenderStateOverride;
  readonly priority: number;
  readonly fallbackFor?: readonly MaterialTechniqueRole[];
  readonly compatibility: Readonly<MaterialTechniqueCompatibility>;
}

export interface MaterialTechniqueRequest {
  readonly phase: RenderPhaseKind;
  readonly allowedRoles: readonly MaterialTechniqueRole[];
  readonly availableFeatures: readonly string[];
  readonly availableMaterialFeatures: readonly string[];
  readonly availableViewFeatures: readonly string[];
  readonly availableMeshCapabilities: readonly string[];
  readonly bindingLayoutHash: string;
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly semanticTag: string;
}

export type MaterialTechniqueSelection =
  | Readonly<{
      status: 'selected' | 'fallback';
      technique: MaterialTechnique;
      requestedRole: MaterialTechniqueRole;
      selectedRole: MaterialTechniqueRole;
      fallbackReason?: string;
      candidatesExamined: number;
    }>
  | Readonly<{
      status: 'unsupported';
      requestedRole?: MaterialTechniqueRole;
      candidatesExamined: number;
      diagnostic: Readonly<MaterialDiagnostic & { readonly reasons: readonly string[] }>;
    }>;

export interface MaterialAsset<D extends MaterialFieldDefinitions = MaterialFieldDefinitions> {
  readonly id: string;
  readonly version: number;
  readonly schema: MaterialSchema<D>;
  readonly techniques: readonly MaterialTechnique[];
  readonly defaults: MaterialParameterBlock;
  readonly renderState: MaterialRenderStateIntent;
}

export interface MaterialAssetDefinition<
  D extends MaterialFieldDefinitions = MaterialFieldDefinitions
> {
  readonly id: string;
  readonly version: number;
  readonly schema: MaterialSchema<D>;
  readonly techniques: readonly MaterialTechnique[];
  readonly defaults?: MaterialParameterBlock;
  readonly renderState: MaterialRenderStateIntent;
}

export interface ResolvedMaterialAsset<
  D extends MaterialFieldDefinitions = MaterialFieldDefinitions
> {
  readonly reference: MaterialAssetReference;
  readonly asset: MaterialAsset<D>;
}

export interface MaterialInstance {
  readonly asset: MaterialAssetReference;
  readonly revision: number;
  readonly parameters: MaterialParameterBlock;
  readonly keywords: Readonly<Record<string, boolean | string | number>>;
  edit(mutator: (draft: MaterialParameterDraft) => void): MaterialInstance;
  rebase(asset: ResolvedMaterialAsset): MaterialRebaseResult;
}

export interface MaterialOperationFailure {
  readonly ok: false;
  readonly diagnostic: Readonly<MaterialDiagnostic>;
}

export type MaterialRebaseResult =
  { readonly ok: true; readonly instance: MaterialInstance } | MaterialOperationFailure;

export interface MaterialInstanceSnapshot {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly asset: MaterialAssetReference;
  readonly revision: number;
  readonly keywords: Readonly<Record<string, boolean | string | number>>;
  readonly parameters: Readonly<Record<string, MaterialValue>>;
  readonly overrides: Readonly<Record<string, MaterialValue>>;
}

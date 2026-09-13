import type { MaterialDiagnostic } from './diagnostic-types';
import type { MaterialParameterBlock, MaterialParameterDraft } from './parameter-types';
import type { MaterialRenderStateIntent } from './render-state-types';
import type { MaterialFieldDefinitions, MaterialSchema, MaterialValue } from './schema-types';
import type { MaterialTechnique } from './technique-types';

/** Version-tagged stable reference to a material asset. */
export interface MaterialAssetReference {
  readonly assetId: string;
  readonly payloadVersion: number;
}

/** Immutable material definition containing schema, techniques, defaults, and render state. */
export interface MaterialAsset<D extends MaterialFieldDefinitions = MaterialFieldDefinitions> {
  readonly id: string;
  readonly version: number;
  readonly schema: MaterialSchema<D>;
  readonly techniques: readonly MaterialTechnique[];
  readonly defaults: MaterialParameterBlock;
  readonly renderState: MaterialRenderStateIntent;
}

/** Authoring descriptor used to create an immutable MaterialAsset. */
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

/** Pair of verified asset reference and its immutable asset payload. */
export interface ResolvedMaterialAsset<
  D extends MaterialFieldDefinitions = MaterialFieldDefinitions
> {
  readonly reference: MaterialAssetReference;
  readonly asset: MaterialAsset<D>;
}

/** Immutable material instance holding parameter overrides and shader feature keywords. */
export interface MaterialInstance {
  readonly asset: MaterialAssetReference;
  readonly revision: number;
  readonly parameters: MaterialParameterBlock;
  readonly keywords: Readonly<Record<string, boolean | string | number>>;
  edit(mutator: (draft: MaterialParameterDraft) => void): MaterialInstance;
  rebase(asset: ResolvedMaterialAsset): MaterialRebaseResult;
}

/** Structured failure payload emitted by material operations. */
export interface MaterialOperationFailure {
  readonly ok: false;
  readonly diagnostic: Readonly<MaterialDiagnostic>;
}

/** Result of rebasing a material instance onto a new asset revision. */
export type MaterialRebaseResult =
  { readonly ok: true; readonly instance: MaterialInstance } | MaterialOperationFailure;

/** Serialized immutable snapshot of a material instance. */
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

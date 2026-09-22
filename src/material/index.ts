export { MaterialDiagnosticError } from './diagnostics';
export * from './builtins';
export { defineMaterialSchema } from './schema';
export {
  createMaterialSamplerReference,
  createMaterialTextureReference,
  defineOffsetField,
  defineTextureField,
  defineTransformField,
  defineUvField
} from './schema-helpers';
export {
  assertNonNegativeScalar,
  assertNonNegativeVector,
  assertNormalizedScalar,
  assertNormalizedVector
} from './validation';
export { createMaterialTechniqueRole, selectMaterialTechnique } from './technique';
export { resolveMaterialRenderState } from './render-state';
export type {
  MaterialRenderPhaseContext,
  MaterialRenderStateConflict,
  ResolvedMaterialRenderState
} from './render-state';
export {
  compileMaterialParameterLayout,
  createMaterialParameterUploadRanges,
  uploadMaterialParameterRanges,
  writeMaterialParameters
} from './parameter-layout';
export type {
  CompiledMaterialParameterField,
  CompiledMaterialParameterLayout,
  MaterialDirtyRange,
  MaterialParameterWrite,
  MaterialParameterWriteCounters,
  MaterialParameterUploadResult
} from './parameter-layout';
export {
  createMaterialParameterBlock,
  getMaterialMetrics,
  resetMaterialMetrics
} from './parameter-block';
export {
  createMaterialAsset,
  createMaterialInstance,
  rehydrateMaterialInstance,
  resolveMaterialAsset,
  snapshotMaterialInstance
} from './asset';
export type {
  MaterialAsset,
  MaterialAssetDefinition,
  MaterialAssetReference,
  MaterialBindingDiagnosticCode,
  MaterialDiagnostic,
  MaterialDiagnosticCode,
  MaterialEditDiagnosticCode,
  MaterialField,
  MaterialFieldDefinition,
  MaterialFieldDefinitions,
  MaterialFieldIndex,
  MaterialFields,
  MaterialInstance,
  MaterialInstanceSnapshot,
  MaterialMetrics,
  MaterialOperationFailure,
  MaterialParameterBlock,
  MaterialParameterDraft,
  MaterialRebaseResult,
  MaterialBlendIntent,
  MaterialCullMode,
  MaterialRenderStateOverride,
  MaterialRenderStateIntent,
  MaterialShaderEntryRef,
  MaterialSamplerReference,
  MaterialSchema,
  MaterialTechniqueDiagnosticCode,
  MaterialTechnique,
  MaterialTechniqueCompatibility,
  MaterialTechniqueRequest,
  MaterialTechniqueRole,
  MaterialTechniqueSelection,
  MaterialSurfaceKind,
  MaterialTextureReference,
  MaterialValue,
  MaterialValueFromDefinition,
  MaterialValueFromValueType,
  MaterialValueType,
  ResolvedMaterialAsset
} from './types';

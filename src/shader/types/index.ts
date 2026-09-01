export type { SourceSpan, ShaderDiagnostic } from './diagnostics';

export type {
  ShaderSourceRef,
  ShaderSourceResolver,
  ShaderSourceModule,
  ShaderIncludeReference,
  ResolvedShaderSource,
  ShaderSourceKind,
  ShaderBindingKind,
  ShaderAuthoringSource,
  DefineShaderAuthoringSourceOptions,
  WgslEntryMetadata,
  WgslImportRef,
  WgslVariantDimension,
  WgslCapabilityRequirement,
  WgslMaterialBindingMetadata,
  WgslCookPolicy,
  WgslShaderMetadata,
  CookedShaderToolchainInfo,
  CookedShaderSourceInfo,
  CookedShaderBinding,
  CookedShaderEntryPoint,
  CookedShaderModules,
  CookedShaderRuntimeArtifact,
  NativeWgslCookResult
} from './source';

export type {
  ShaderLayoutPolicyId,
  ShaderTarget,
  ShaderScalarKind,
  ShaderStage,
  BufferFieldLayoutShape,
  BufferFieldLayout,
  BufferLayoutManifest,
  ShaderBufferBindingEntryManifest,
  ShaderTextureBindingEntryManifest,
  ShaderSamplerBindingEntryManifest,
  ShaderBindingEntryManifest,
  BindingGroupManifest,
  ShaderSamplerBindingRequirement,
  ShaderBindingRequirement,
  ShaderBindingManifestOptions,
  ShaderBindingReflectionDiagnosticCode,
  ShaderBindingReflectionDiagnostic,
  ShaderBindingManifest
} from './manifest';

export type { ShaderCompileRequest } from './compiler';

export type {
  FluxAttribute,
  FluxTypeNode,
  FluxParameterNode,
  FluxStructNode,
  FluxGlobalNode,
  FluxVariantNode,
  FluxFunctionNode,
  FluxDeclarationNode,
  FluxModuleNode,
  FluxExpressionNode,
  FluxStatementNode,
  FluxSwitchCaseNode
} from './ast';

export type {
  ShaderGraphNode,
  ShaderGraph,
  ShaderGraphWorkerRequest,
  ShaderGraphWorkerResult,
  ShaderGraphWorkerPort,
  ShaderGraphServiceResult
} from './graph';

export type {
  ShaderBinaryExpressionIR,
  ShaderCallExpressionIR,
  ShaderConstructExpressionIR,
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFieldExpressionIR,
  ShaderFunctionId,
  ShaderFunctionIR,
  ShaderGlobalIR,
  ShaderIndexExpressionIR,
  ShaderIntrinsicExpressionIR,
  ShaderLiteralExpressionIR,
  ShaderModuleIR,
  ShaderParameterIR,
  ShaderSourceMap,
  ShaderStatementIR,
  ShaderStructFieldIR,
  ShaderStructTypeIR,
  ShaderSwitchCaseIR,
  ShaderSymbolExpressionIR,
  ShaderSymbolId,
  ShaderTypeId,
  ShaderTypeIR,
  ShaderUnaryExpressionIR,
  ShaderVariantDimension
} from '../ir';

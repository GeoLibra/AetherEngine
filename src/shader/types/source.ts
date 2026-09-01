import type { SourceSpan } from './diagnostics';

export interface ShaderSourceRef {
  readonly uri: string;
  readonly languageVersion: number;
}

export interface ShaderSourceResolver {
  load(uri: string): Promise<string>;
}

export interface ShaderSourceModule {
  readonly uri: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface ShaderIncludeReference {
  readonly from: string;
  readonly to: string;
  readonly span: SourceSpan;
}

export interface ResolvedShaderSource {
  readonly root: ShaderSourceRef;
  readonly modules: readonly ShaderSourceModule[];
  readonly references: readonly ShaderIncludeReference[];
  readonly hash: string;
}

export type {
  ShaderSourceKind,
  ShaderAuthoringSource,
  DefineShaderAuthoringSourceOptions,
  WgslEntryMetadata,
  WgslImportRef,
  WgslVariantDimension,
  WgslCapabilityRequirement,
  WgslMaterialBindingMetadata,
  WgslCookPolicy,
  WgslShaderMetadata
} from './authoring';

export type {
  CookedShaderToolchainInfo,
  CookedShaderSourceInfo,
  CookedShaderBinding,
  CookedShaderEntryPoint,
  CookedShaderModules,
  CookedShaderRuntimeArtifact,
  NativeWgslCookResult
} from './artifact';

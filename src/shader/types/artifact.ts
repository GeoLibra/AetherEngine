/**
 * @file Cooked runtime artifact contracts and types.
 */

import type { ShaderSourceKind } from './authoring';

/**
 * Toolchain provenance for a cooked shader artifact.
 */
export interface CookedShaderToolchainInfo {
  readonly cookerId: string;
  readonly cookerVersion: string;
  readonly nagaVersion: string;
}

/**
 * Source provenance for a cooked shader artifact.
 */
export interface CookedShaderSourceInfo {
  readonly sourceUri: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

/**
 * Allowed reflected binding kinds in cooked runtime artifacts.
 */
export type ShaderBindingKind =
  | 'uniform-buffer'
  | 'storage-buffer'
  | 'texture'
  | 'sampler'
  | 'storage-texture'
  | 'comparison-sampler';

/**
 * Reflected binding item in a cooked shader artifact.
 */
export interface CookedShaderBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: ShaderBindingKind;
  readonly addressSpace: string;
  readonly access: string;
  readonly typeName: string;
  readonly [key: string]: unknown;
}

/** Flattened leaf field reflected from a cooked WGSL buffer layout. */
export interface CookedShaderBufferField {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly typeName: string;
}

/** Canonical layout reflected for one bound uniform or storage buffer. */
export interface CookedShaderBufferLayout {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly byteSize: number;
  readonly alignment: number;
  readonly fields: readonly CookedShaderBufferField[];
}

/** Canonical location-bound stage input or output reflected by the cooker. */
export interface CookedShaderStageIo {
  readonly location: number;
  readonly name: string;
  readonly typeName: string;
}

/** Canonical logical resource coordinates referenced by backend program metadata. */
export interface CookedShaderBindingReference {
  readonly group: number;
  readonly binding: number;
}

/** Generated GLSL program symbol mapped back to one or more canonical shader resources. */
export type CookedGlslProgramBinding =
  | Readonly<{
      kind: 'uniform-buffer';
      name: string;
      resource: CookedShaderBindingReference;
    }>
  | Readonly<{
      kind: 'combined-sampler';
      name: string;
      texture: CookedShaderBindingReference;
      sampler?: CookedShaderBindingReference | undefined;
    }>;

/** One validated GLSL ES 3.00 module and its generated program symbols. */
export interface CookedGlslEs300Module {
  readonly source: string;
  readonly bindings: readonly CookedGlslProgramBinding[];
}

/**
 * Reflected entry point record in a cooked shader artifact.
 */
export interface CookedShaderEntryPoint {
  readonly name: string;
  readonly stage: 'vertex' | 'fragment' | 'compute';
  readonly bindings: readonly CookedShaderBinding[];
}

/**
 * Cooked backend module sources.
 */
export interface CookedShaderModules {
  readonly wgsl: string;
  readonly glslEs300: Readonly<Record<string, CookedGlslEs300Module>>;
}

/**
 * Immutable runtime artifact consumed by the engine.
 * Free of compiler, parser, AST, Naga IR, or local file paths.
 */
export interface CookedShaderRuntimeArtifact {
  readonly schemaVersion: 2;
  readonly shaderManifestSchemaVersion: 1;
  readonly shaderModuleSchemaVersion: 2;
  readonly sourceKind: ShaderSourceKind;
  readonly targetBackend?: 'webgpu' | 'webgl2';
  readonly toolchain: CookedShaderToolchainInfo;
  readonly source: CookedShaderSourceInfo;
  readonly entryPoints: readonly CookedShaderEntryPoint[];
  readonly bindings: readonly CookedShaderBinding[];
  readonly bufferLayouts: readonly CookedShaderBufferLayout[];
  readonly vertexInputs: readonly CookedShaderStageIo[];
  readonly fragmentOutputs: readonly CookedShaderStageIo[];
  readonly modules: CookedShaderModules;
}

/**
 * Raw output payload from native WGSL cooker.
 */
export type NativeWgslCookResult = CookedShaderRuntimeArtifact;

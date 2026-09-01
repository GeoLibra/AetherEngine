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
 * Reflected binding item in a cooked shader artifact.
 */
export interface CookedShaderBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: string;
  readonly addressSpace?: string;
  readonly access?: string;
  readonly typeName?: string;
  readonly [key: string]: unknown;
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
  readonly glslEs300: Readonly<Record<string, string>>;
}

/**
 * Immutable runtime artifact consumed by the engine.
 * Free of compiler, parser, AST, Naga IR, or local file paths.
 */
export interface CookedShaderRuntimeArtifact {
  readonly schemaVersion: 1;
  readonly shaderManifestSchemaVersion: 1;
  readonly shaderModuleSchemaVersion: 1;
  readonly sourceKind: ShaderSourceKind;
  readonly toolchain: CookedShaderToolchainInfo;
  readonly source: CookedShaderSourceInfo;
  readonly entryPoints: readonly CookedShaderEntryPoint[];
  readonly bindings: readonly CookedShaderBinding[];
  readonly modules: CookedShaderModules;
}

/**
 * Raw output payload from native WGSL cooker.
 */
export type NativeWgslCookResult = CookedShaderRuntimeArtifact;

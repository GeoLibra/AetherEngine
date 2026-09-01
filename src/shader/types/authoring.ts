/**
 * @file Closed authoring source types and typed WGSL metadata definitions.
 */

/**
 * Closed set of supported shader source kinds.
 * Standard WGSL is the default production text frontend.
 */
export type ShaderSourceKind = 'wgsl' | 'flux-experimental' | 'shader-graph';

/**
 * Normalized authoring source reference.
 */
export interface ShaderAuthoringSource {
  readonly kind: ShaderSourceKind;
  readonly uri: string;
  readonly languageVersion: string;
}

/**
 * Input options for defining an authoring source.
 */
export interface DefineShaderAuthoringSourceOptions {
  readonly uri: string;
  readonly kind?: ShaderSourceKind;
  readonly languageVersion?: string;
}

/**
 * Metadata entry point definition.
 */
export interface WgslEntryMetadata {
  readonly name: string;
  readonly stage: 'vertex' | 'fragment' | 'compute';
  readonly label?: string;
}

/**
 * Import reference in WGSL sidecar metadata.
 */
export interface WgslImportRef {
  readonly path: string;
  readonly alias?: string;
}

/**
 * Variant dimension in WGSL sidecar metadata.
 */
export interface WgslVariantDimension {
  readonly name: string;
  readonly values: readonly string[];
  readonly defaultValue?: string;
}

/**
 * Capability requirement in WGSL sidecar metadata.
 */
export interface WgslCapabilityRequirement {
  readonly feature: string;
  readonly fallback?: string;
}

/**
 * Material binding metadata.
 */
export interface WgslMaterialBindingMetadata {
  readonly binding: string;
  readonly property: string;
}

/**
 * Cook policy options for WGSL authoring.
 */
export interface WgslCookPolicy {
  readonly optimization?: 'none' | 'size' | 'performance';
  readonly preserveNames?: boolean;
}

/**
 * Typed WGSL shader sidecar metadata contract.
 */
export interface WgslShaderMetadata {
  readonly schemaVersion: 1;
  readonly entryPoints: readonly WgslEntryMetadata[];
  readonly imports?: readonly WgslImportRef[];
  readonly variants?: readonly WgslVariantDimension[];
  readonly capabilityRequirements?: readonly WgslCapabilityRequirement[];
  readonly materialBindings?: readonly WgslMaterialBindingMetadata[];
  readonly cookPolicy?: WgslCookPolicy;
}

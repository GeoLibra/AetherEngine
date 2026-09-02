import type { ShaderSourceKind } from '../../../shader/types';

export type RenderArtifactSectionKind =
  | 'manifest'
  | 'material-schema'
  | 'techniques'
  | 'variant-table'
  | 'reflection'
  | 'layout-plans'
  | 'typed-ir'
  | 'source'
  | 'shader-module'
  | 'dependencies'
  | 'source-map'
  | 'debug-symbols';

/** Declares which semantic closure and required sections a render package publishes. */
export type RenderArtifactKind = 'shader-library' | 'material';

export interface RenderArtifactShaderToolchain {
  readonly cookerId: string;
  readonly cookerVersion: string;
  readonly sourceKind: ShaderSourceKind;
  readonly sourceLanguageVersion: string;
  readonly nagaVersion?: string | undefined;
  readonly metadataSchemaVersion: number;
}

export interface RenderArtifactPackageSectionInput {
  readonly id: string;
  readonly kind: RenderArtifactSectionKind;
  readonly required: boolean;
  readonly target?: RenderArtifactTargetSelector;
  readonly payload: unknown;
}

/** Selects a cooked module without reading its external blob payload. */
export interface RenderArtifactTargetSelector {
  readonly shaderTarget: 'wgsl' | 'glsl300es';
  readonly entryPoint?: string;
  readonly stage?: 'vertex' | 'fragment' | 'compute';
}

export interface RenderArtifactExternalSectionLocation {
  readonly storage: 'external';
  readonly blobId: string;
}

export interface RenderArtifactContainerSectionLocation {
  readonly storage: 'container';
  readonly offset: number;
  readonly compressedLength: number;
  readonly codec: 'identity' | 'zstd';
}

export type RenderArtifactSectionLocation =
  RenderArtifactExternalSectionLocation | RenderArtifactContainerSectionLocation;

export interface RenderArtifactPackageInputBase {
  readonly containerVersion?: number | undefined;
  readonly manifestSchemaVersion?: number | undefined;
  readonly shaderManifestSchemaVersion?: number | undefined;
  readonly shaderModuleSchemaVersion?: number | undefined;
  readonly shaderAbiVersion: number;
  readonly toolchain: Readonly<{ id: string; version: string }>;
  readonly shaderToolchain: RenderArtifactShaderToolchain;
  readonly sections: readonly RenderArtifactPackageSectionInput[];
}

export type RenderArtifactPackageInput = RenderArtifactPackageInputBase &
  (
    | Readonly<{ artifactKind: 'shader-library'; materialSchemaVersion?: never }>
    | Readonly<{ artifactKind: 'material'; materialSchemaVersion: number }>
  );

export interface RenderArtifactSectionIndex {
  readonly id: string;
  readonly kind: RenderArtifactSectionKind;
  readonly uncompressedLength: number;
  readonly hash: string;
  readonly required: boolean;
  readonly target?: RenderArtifactTargetSelector;
  readonly location: RenderArtifactSectionLocation;
}

export interface RenderArtifactEnvelope {
  readonly magic: 'AERENDER';
  readonly artifactKind: RenderArtifactKind;
  readonly containerVersion: 1;
  readonly manifestSchemaVersion: 1;
  readonly shaderManifestSchemaVersion: 1;
  readonly shaderModuleSchemaVersion: 2;
  readonly shaderAbiVersion: number;
  readonly materialSchemaVersion?: number;
  readonly toolchain: Readonly<{ id: string; version: string }>;
  readonly shaderToolchain: RenderArtifactShaderToolchain;
  readonly packageId: string;
  readonly semanticContentHash: string;
  readonly containerHash: string;
  readonly sections: readonly RenderArtifactSectionIndex[];
}

export interface DecodedRenderArtifactPackage {
  readonly envelope: RenderArtifactEnvelope;
  readonly sections: readonly Readonly<RenderArtifactPackageSectionInput>[];
}

/** Canonical reference envelope plus owned copies of independently addressable section bytes. */
export interface RenderArtifactReferenceBundle {
  readonly manifest: string;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

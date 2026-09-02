import type { CookedShaderRuntimeArtifact } from '../../../shader/types';
import type { AssetHandle } from '../../types';
import type { DecodedCookedShaderPackage } from '../shader-package';
import type { DecodedRenderArtifactPackage, RenderArtifactReferenceBundle } from './package-types';

export type ShaderPackageChangedKind = 'initial' | 'module-only' | 'dependencies' | 'layout-abi';

export interface PublishedShaderPackage {
  readonly handle: AssetHandle<PublishedShaderPackage>;
  readonly packageId: string;
  readonly semanticContentHash: string;
  readonly shaderAbiVersion: number;
  readonly package: DecodedRenderArtifactPackage;
  readonly artifact: CookedShaderRuntimeArtifact;
}

export interface ShaderPackagePayload {
  readonly version: number;
  readonly contentHash: string;
  readonly value: PublishedShaderPackage;
}

export type ShaderPackageResolveResult =
  | Readonly<{ kind: 'available'; payload: ShaderPackagePayload }>
  | Readonly<{ kind: 'unavailable' }>;

export interface ShaderPackageStageRequest {
  readonly revision: number;
  readonly bundle: RenderArtifactReferenceBundle;
}

export interface ShaderPackageDecoder {
  decode(bundle: RenderArtifactReferenceBundle): Promise<DecodedCookedShaderPackage>;
}

export interface ShaderPackageHmrPublisherOptions {
  readonly decoder?: ShaderPackageDecoder;
  readonly compatibilityPreparer?: ShaderPackageCompatibilityPreparer;
}

export interface ShaderPackageCompatibilityPreparation {
  readonly revision: number;
  readonly handle: AssetHandle<PublishedShaderPackage>;
  readonly current: PublishedShaderPackage;
  readonly candidate: PublishedShaderPackage;
}

export type ShaderPackageCompatibilityPreparationResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>;

export interface ShaderPackageCompatibilityPreparer {
  prepare(
    preparation: ShaderPackageCompatibilityPreparation
  ): Promise<ShaderPackageCompatibilityPreparationResult>;
}

export interface ShaderPackageHmrDiagnostic {
  readonly code:
    | 'shader-package-validation-failed'
    | 'shader-package-layout-rebase-required'
    | 'shader-package-layout-rebase-failed';
  readonly message: string;
}

export type ShaderPackageStageResult =
  | Readonly<{
      status: 'staged';
      revision: number;
      packageId: string;
      changedKind: ShaderPackageChangedKind;
    }>
  | Readonly<{
      status: 'failed';
      revision: number;
      diagnostic: ShaderPackageHmrDiagnostic;
    }>
  | Readonly<{ status: 'stale'; revision: number }>;

export type ShaderPackageHmrSnapshot =
  | Readonly<{ kind: 'unloaded'; lastGoodVersion: undefined }>
  | Readonly<{
      kind: 'staging';
      revision: number;
      lastGoodVersion: number | undefined;
    }>
  | Readonly<{
      kind: 'staged';
      revision: number;
      changedKind: ShaderPackageChangedKind;
      lastGoodVersion: number | undefined;
    }>
  | Readonly<{
      kind: 'published';
      revision: number;
      version: number;
      packageId: string;
      lastGoodVersion: number;
    }>
  | Readonly<{
      kind: 'failed';
      revision: number;
      diagnostic: ShaderPackageHmrDiagnostic;
      lastGoodVersion: number | undefined;
    }>;

export interface ShaderPackageListenerDiagnostic {
  readonly code: 'shader-package-listener-failed';
  readonly message: string;
}

/** Immutable notification emitted after a package revision becomes observable. */
export interface ShaderPackagePublishedEvent {
  readonly handle: AssetHandle<PublishedShaderPackage>;
  readonly revision: number;
  readonly packageId: string;
  readonly oldVersion: number | undefined;
  readonly newVersion: number;
  readonly changedKind: ShaderPackageChangedKind;
}

/** Observes successful atomic package publications. */
export type ShaderPackagePublishedListener = (event: ShaderPackagePublishedEvent) => void;

export type ShaderPackageCommitResult =
  | Readonly<{
      status: 'published';
      revision: number;
      oldVersion: number | undefined;
      newVersion: number;
      changedKind: ShaderPackageChangedKind;
      listenerDiagnostics: readonly ShaderPackageListenerDiagnostic[];
    }>
  | Readonly<{ status: 'not-staged'; revision: number }>;

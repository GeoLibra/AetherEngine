import { defineAssetType } from '../asset-handle';
import type { AssetHandle } from '../types';
import { decodeCookedShaderPackage } from './shader-package';
import type {
  PublishedShaderPackage,
  ShaderPackageChangedKind,
  ShaderPackageCommitResult,
  ShaderPackageHmrDiagnostic,
  ShaderPackageHmrPublisherOptions,
  ShaderPackageHmrSnapshot,
  ShaderPackageListenerDiagnostic,
  ShaderPackagePublishedEvent,
  ShaderPackagePublishedListener,
  ShaderPackageResolveResult,
  ShaderPackageStageRequest,
  ShaderPackageStageResult
} from './types';

/** Stable asset type for a validated shader-library package payload. */
export const ShaderPackageAssetType =
  defineAssetType<PublishedShaderPackage>('asset.shader-package');

interface StagedShaderPackage {
  readonly revision: number;
  readonly changedKind: ShaderPackageChangedKind;
  readonly value: PublishedShaderPackage;
}

/** Stages complete shader packages and publishes them only at an explicit frame boundary. */
export class ShaderPackageHmrPublisher {
  readonly handle: AssetHandle<PublishedShaderPackage>;
  #staged: StagedShaderPackage | undefined;
  #published: ShaderPackagePayloadState | undefined;
  #snapshot: ShaderPackageHmrSnapshot = UNLOADED_SNAPSHOT;
  #latestRequestedRevision = 0;
  readonly #decoder: NonNullable<ShaderPackageHmrPublisherOptions['decoder']>;
  readonly #compatibilityPreparer: ShaderPackageHmrPublisherOptions['compatibilityPreparer'];
  readonly #listeners = new Set<ShaderPackagePublishedListener>();

  constructor(
    handle: AssetHandle<PublishedShaderPackage>,
    options: ShaderPackageHmrPublisherOptions = {}
  ) {
    if (handle.type !== ShaderPackageAssetType) {
      throw new Error('Shader package publisher requires a shader package asset handle.');
    }
    this.handle = handle;
    this.#decoder = options.decoder ?? DEFAULT_SHADER_PACKAGE_DECODER;
    this.#compatibilityPreparer = options.compatibilityPreparer;
  }

  /** Validates and stages one complete package revision without publishing it. */
  async stage(request: ShaderPackageStageRequest): Promise<ShaderPackageStageResult> {
    if (!Number.isInteger(request.revision) || request.revision <= 0) {
      throw new Error('Shader package revision must be a positive integer.');
    }
    if (request.revision <= this.#latestRequestedRevision) {
      throw new Error('Shader package revisions must be requested in strictly increasing order.');
    }
    this.#latestRequestedRevision = request.revision;
    this.#staged = undefined;
    this.#snapshot = Object.freeze({
      kind: 'staging',
      revision: request.revision,
      lastGoodVersion: this.#published?.version
    });
    let decoded: Awaited<ReturnType<typeof decodeCookedShaderPackage>>;
    try {
      decoded = await this.#decoder.decode(request.bundle);
    } catch (cause) {
      if (request.revision !== this.#latestRequestedRevision) {
        return Object.freeze({ status: 'stale', revision: request.revision });
      }
      return this.#failStage(request.revision, {
        code: 'shader-package-validation-failed' as const,
        message: cause instanceof Error ? cause.message : 'Shader package validation failed.'
      });
    }
    if (request.revision !== this.#latestRequestedRevision) {
      return Object.freeze({ status: 'stale', revision: request.revision });
    }
    const value = Object.freeze({
      handle: this.handle,
      packageId: decoded.package.envelope.packageId,
      semanticContentHash: decoded.package.envelope.semanticContentHash,
      shaderAbiVersion: decoded.package.envelope.shaderAbiVersion,
      package: decoded.package,
      artifact: decoded.artifact
    });
    const changedKind = classifyChange(this.#published?.value.package, decoded.package);
    if (changedKind === 'layout-abi' && this.#published) {
      if (!this.#compatibilityPreparer) {
        return this.#failStage(request.revision, {
          code: 'shader-package-layout-rebase-required',
          message: 'Layout ABI changes require compatibility preparation before publication.'
        });
      }
      let preparationResult;
      try {
        preparationResult = await this.#compatibilityPreparer.prepare({
          revision: request.revision,
          handle: this.handle,
          current: this.#published.value,
          candidate: value
        });
      } catch (cause) {
        if (request.revision !== this.#latestRequestedRevision) {
          return Object.freeze({ status: 'stale', revision: request.revision });
        }
        return this.#failStage(request.revision, {
          code: 'shader-package-layout-rebase-failed',
          message: cause instanceof Error ? cause.message : 'Layout ABI preparation failed.'
        });
      }
      if (request.revision !== this.#latestRequestedRevision) {
        return Object.freeze({ status: 'stale', revision: request.revision });
      }
      if (!preparationResult.ok) {
        return this.#failStage(request.revision, {
          code: 'shader-package-layout-rebase-failed',
          message: preparationResult.message
        });
      }
    }
    this.#staged = Object.freeze({ revision: request.revision, changedKind, value });
    this.#snapshot = Object.freeze({
      kind: 'staged',
      revision: request.revision,
      changedKind,
      lastGoodVersion: this.#published?.version
    });
    return Object.freeze({
      status: 'staged',
      revision: request.revision,
      packageId: value.packageId,
      changedKind
    });
  }

  /** Atomically publishes the matching staged revision at a caller-owned frame boundary. */
  commit(revision: number): ShaderPackageCommitResult {
    if (!this.#staged || this.#staged.revision !== revision) {
      return Object.freeze({ status: 'not-staged', revision });
    }
    const oldVersion = this.#published?.version;
    const newVersion = (oldVersion ?? 0) + 1;
    this.#published = Object.freeze({
      version: newVersion,
      contentHash: this.#staged.value.semanticContentHash,
      value: this.#staged.value
    });
    const changedKind = this.#staged.changedKind;
    const packageId = this.#staged.value.packageId;
    this.#staged = undefined;
    this.#snapshot = Object.freeze({
      kind: 'published',
      revision,
      version: newVersion,
      packageId,
      lastGoodVersion: newVersion
    });
    const event: ShaderPackagePublishedEvent = Object.freeze({
      handle: this.handle,
      revision,
      packageId,
      oldVersion,
      newVersion,
      changedKind
    });
    const listenerDiagnostics: ShaderPackageListenerDiagnostic[] = [];
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (cause) {
        listenerDiagnostics.push(
          Object.freeze({
            code: 'shader-package-listener-failed',
            message: cause instanceof Error ? cause.message : 'Shader package listener failed.'
          })
        );
      }
    }
    return Object.freeze({
      status: 'published',
      revision,
      oldVersion,
      newVersion,
      changedKind,
      listenerDiagnostics:
        listenerDiagnostics.length === 0
          ? EMPTY_LISTENER_DIAGNOSTICS
          : Object.freeze(listenerDiagnostics)
    });
  }

  /** Resolves the last atomically published package payload. */
  resolve(): ShaderPackageResolveResult {
    return this.#published
      ? Object.freeze({ kind: 'available', payload: this.#published })
      : UNAVAILABLE_PACKAGE;
  }

  /** Returns the immutable publication state for diagnostics and tooling. */
  snapshot(): ShaderPackageHmrSnapshot {
    return this.#snapshot;
  }

  /** Subscribes to successful publications and returns an idempotent unsubscribe function. */
  subscribe(listener: ShaderPackagePublishedListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #failStage(
    revision: number,
    diagnosticInput: ShaderPackageHmrDiagnostic
  ): Extract<ShaderPackageStageResult, { status: 'failed' }> {
    this.#staged = undefined;
    const diagnostic = Object.freeze(diagnosticInput);
    this.#snapshot = Object.freeze({
      kind: 'failed',
      revision,
      diagnostic,
      lastGoodVersion: this.#published?.version
    });
    return Object.freeze({ status: 'failed', revision, diagnostic });
  }
}

type ShaderPackagePayloadState = Readonly<{
  version: number;
  contentHash: string;
  value: PublishedShaderPackage;
}>;

const UNAVAILABLE_PACKAGE = Object.freeze({ kind: 'unavailable' as const });
const UNLOADED_SNAPSHOT = Object.freeze({ kind: 'unloaded' as const, lastGoodVersion: undefined });
const EMPTY_LISTENER_DIAGNOSTICS = Object.freeze([]);
const DEFAULT_SHADER_PACKAGE_DECODER = Object.freeze({ decode: decodeCookedShaderPackage });

function classifyChange(
  current: PublishedShaderPackage['package'] | undefined,
  candidate: PublishedShaderPackage['package']
): ShaderPackageChangedKind {
  if (!current) return 'initial';
  if (
    current.envelope.shaderAbiVersion !== candidate.envelope.shaderAbiVersion ||
    sectionHash(current, 'shader-reflection') !== sectionHash(candidate, 'shader-reflection') ||
    sectionHash(current, 'shader-layout-plans') !== sectionHash(candidate, 'shader-layout-plans')
  ) {
    return 'layout-abi';
  }
  if (
    sectionHash(current, 'shader-dependencies') !== sectionHash(candidate, 'shader-dependencies')
  ) {
    return 'dependencies';
  }
  return 'module-only';
}

function sectionHash(packageValue: PublishedShaderPackage['package'], id: string): string {
  const section = packageValue.envelope.sections.find((entry) => entry.id === id);
  if (!section)
    throw new Error(`[shader-package-section-missing] Required section "${id}" is missing.`);
  return section.hash;
}

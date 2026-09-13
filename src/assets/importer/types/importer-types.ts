import type { CanonicalAssetBundle, CanonicalAssetDocument } from '../../canonical';
import type { VirtualFileSystem } from '../../vfs';

export type AssetImporterId = string;
export type AssetSourceKind = 'file' | 'buffer' | 'stream';
export type AssetKind = 'scene' | 'mesh' | 'material' | 'texture' | 'sampler';

/** Source data descriptor passed to probes and importers. */
export interface AssetSource {
  readonly uri: string;
  readonly kind: AssetSourceKind;
  readonly buffer?: Uint8Array;
  readonly mimeType?: string;
  readonly extension?: string;
  readonly sizeBytes?: number;
}

/** Limited probe slice for inspecting file headers without downloading complete payload. */
export interface AssetProbe {
  readonly uri: string;
  readonly headerBytes: Uint8Array;
  readonly declaredMimeType?: string;
  readonly declaredExtension?: string;
  readonly sizeBytes?: number;
}

export type AssetProbeResult =
  | { readonly match: true; readonly confidence: number; readonly estimatedKind: AssetKind }
  | { readonly match: false; readonly reason?: string };

export type AssetImportFailureCode =
  | 'unsupported-format'
  | 'invalid-magic'
  | 'ambiguous-format'
  | 'size-limit-exceeded'
  | 'dependency-not-found'
  | 'unsupported-required-extension'
  | 'unsupported-profile'
  | 'cancelled';

export interface AssetDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly targetUri?: string;
  readonly byteOffset?: number;
}

export interface AssetDiagnosticSink {
  report(diagnostic: AssetDiagnostic): void;
  getDiagnostics(): readonly AssetDiagnostic[];
}

export interface AssetImportStatistics {
  readonly parseTimeMs: number;
  readonly readBytes: number;
  readonly copiedBytes: number;
  readonly documentCount: number;
}

export interface AssetImportFailure {
  readonly code: AssetImportFailureCode;
  readonly message: string;
  readonly uri: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type AssetImportResult<TDocument extends CanonicalAssetDocument> =
  | Readonly<{
      kind: 'success';
      document: TDocument;
      bundle?: CanonicalAssetBundle;
      documents?: readonly CanonicalAssetDocument[];
      dependencies: readonly AssetDependency[];
      diagnostics: readonly AssetDiagnostic[];
      statistics: AssetImportStatistics;
    }>
  | Readonly<{
      kind: 'failure';
      failure: AssetImportFailure;
      diagnostics: readonly AssetDiagnostic[];
    }>;

export interface AssetDependency {
  readonly uri: string;
  readonly kind: 'buffer' | 'image' | 'material' | 'mesh';
  readonly required: boolean;
}

export interface AssetDependencyResolver {
  resolve(parentUri: string, relativeUri: string): string;
  load(uri: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface AssetImportBudget {
  readonly maxSizeBytes: number;
  readonly maxAllocationBytes: number;
  readonly timeoutMs: number;
  checkAllocated(bytes: number): void;
  recordRead(bytes: number): void;
}

export interface AssetImportContext {
  readonly vfs: VirtualFileSystem;
  readonly signal: AbortSignal;
  readonly budget: AssetImportBudget;
  readonly diagnostics: AssetDiagnosticSink;
  readonly dependencies: AssetDependencyResolver;
}

export interface AssetProbeContext {
  readonly signal: AbortSignal;
}

export interface AssetMagicSignature {
  readonly offset: number;
  readonly bytes: readonly number[];
}

/** Public contract for an asset format importer. */
export interface AssetImporter<TDocument extends CanonicalAssetDocument> {
  readonly id: AssetImporterId;
  readonly version: string;
  readonly acceptedKinds: readonly AssetSourceKind[];
  readonly outputKinds: readonly AssetKind[];

  probe(source: AssetProbe, context: AssetProbeContext): Promise<AssetProbeResult>;

  import(source: AssetSource, context: AssetImportContext): Promise<AssetImportResult<TDocument>>;
}

export interface AssetImporterDescriptor {
  readonly importer: AssetImporter<CanonicalAssetDocument>;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly magicSignatures: readonly AssetMagicSignature[];
  readonly priority: number;
}

import type { CanonicalVFSUri } from './vfs-types';

/** Complete transport identity key used for in-flight request deduplication and cache partitioning. */
export type VFSTransportKey = string & { readonly __vfsTransportKey: unique symbol };

/** Retry guidance metadata safe to return with transient failures. */
export interface VFSRetryMetadata {
  readonly canRetry: boolean;
  readonly retryAfterMs?: number;
}

/** Redacted transport metadata safe to expose in logs, metrics, or diagnostics. */
export interface VFSRedactedMetadata {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Options controlling relative dependency resolution. */
export interface VFSDependencyResolveOptions {
  /** If true, permits resolving to an absolute canonical URI outside the base mount. Default is false. */
  readonly allowCrossMount?: boolean;
}

/** Provider-private transport descriptor for remote retrieval. */
export interface VFSTransportLocator {
  readonly transportUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialPartition?: string;
}

/** Resolved pair of canonical logical URI and provider-private transport locator. */
export interface VFSResolvedAuthoringLocator {
  readonly logicalUri: CanonicalVFSUri;
  readonly transport: VFSTransportLocator;
}

/** Remote locator resolver interface separating logical URIs from transport URLs. */
export interface VFSRemoteLocatorResolver {
  resolveLogicalToTransport(
    logicalUri: CanonicalVFSUri
  ): Promise<VFSTransportLocator> | VFSTransportLocator;
  resolveAuthoringToLogical(
    authoringUrl: string
  ): Promise<VFSResolvedAuthoringLocator> | VFSResolvedAuthoringLocator;
}

import type { VFS_FAILURE_KIND } from '../constants';

/** Stable identity of a VFS provider within one mount. */
export type VFSProviderId = string & { readonly __vfsProviderId: unique symbol };

/** Lowercase URI scheme accepted by the asset VFS. */
export type VFSScheme = string & { readonly __vfsScheme: unique symbol };

/** Validated canonical URI that cannot traverse outside its scheme root. */
export type CanonicalVFSUri = string & { readonly __canonicalVfsUri: unique symbol };

/** Validated provider-relative path rooted at `/`. */
export type NormalizedMountPath = string & { readonly __normalizedMountPath: unique symbol };

/** Expected storage failure kinds represented without exceptions. */
export type VFSFailureKind = (typeof VFS_FAILURE_KIND)[keyof typeof VFS_FAILURE_KIND];

/** Capabilities supported by providers in the full-read-only VFS slice. */
export interface VFSProviderCapabilities {
  readonly read: true;
  readonly range: false;
  readonly write: false;
  readonly watch: false;
}

/** Options forwarded to a provider after the request has passed VFS validation. */
export interface VFSReadOptions {
  readonly signal?: AbortSignal;
}

/** Validated provider payload and its durable provenance metadata. */
export interface VFSReadSuccess {
  readonly kind: 'success';
  readonly bytes: Uint8Array;
  readonly resolvedUri: CanonicalVFSUri;
  readonly revision: string;
  readonly contentLength: number;
  readonly mime?: string;
  readonly integrity?: string;
  readonly providerId: VFSProviderId;
}

/** Typed read failure safe to expose across provider and asset boundaries. */
export interface VFSReadFailure {
  readonly kind: VFSFailureKind;
  readonly code: string;
  readonly message: string;
  readonly requestedUri: CanonicalVFSUri;
  readonly providerId?: VFSProviderId;
}

/** Expected provider-local failure before trusted URI provenance is attached. */
export interface VFSProviderReadFailure {
  readonly kind: VFSFailureKind;
  readonly code: string;
  readonly message: string;
}

/** Complete outcome returned by a VFS provider. */
export type VFSProviderReadResult = VFSReadSuccess | VFSProviderReadFailure;

/** Read-only byte provider mounted below a canonical VFS root. */
export interface VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities: VFSProviderCapabilities;
  read(path: NormalizedMountPath, options: VFSReadOptions): Promise<VFSProviderReadResult>;
}

/** Explicit rules controlling cache lookup and primary fallback. */
export interface VFSReadPolicy {
  readonly consultCaches: boolean;
  readonly fallbackOn: readonly ('not-found' | 'offline')[];
}

/** Provider composition bound to one canonical scheme and path root. */
export interface VFSMount {
  readonly scheme: VFSScheme;
  readonly root: CanonicalVFSUri;
  readonly primary: VFSProvider;
  readonly caches: readonly VFSProvider[];
  readonly fallback?: VFSProvider;
  readonly policy: VFSReadPolicy;
}

/** Most-specific registered mount and provider-relative path selected for a URI. */
export interface ResolvedVFSMount {
  readonly mount: VFSMount;
  readonly path: NormalizedMountPath;
}

/** Caller-owned full-read request validated before provider dispatch. */
export interface VFSReadRequest {
  readonly uri: string;
  readonly expectedLength?: number;
  readonly expectedIntegrity?: string;
  readonly signal?: AbortSignal;
}

/** Complete outcome returned from the VFS public read boundary. */
export type VFSReadResult = VFSReadSuccess | VFSReadFailure | VFSBoundaryFailure;

/** Request rejection before provider selection; invalid input has no canonical URI. */
export type VFSBoundaryFailure =
  | Readonly<{
      kind: 'invalid-request';
      code: 'vfs-invalid-request';
      message: string;
    }>
  | Readonly<{
      kind: 'mount-not-found';
      code: 'vfs-mount-not-found';
      message: string;
      requestedUri: CanonicalVFSUri;
    }>;

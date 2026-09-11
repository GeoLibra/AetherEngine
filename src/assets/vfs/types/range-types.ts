import type {
  CanonicalVFSUri,
  VFSBoundaryFailure,
  VFSProviderId,
  VFSReadFailure
} from './vfs-types';

/** Validated byte range with inclusive offset and positive safe-integer length: `[offset, offset + length)`. */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** Caller-owned byte range read request. */
export interface VFSRangeReadRequest {
  readonly uri: string;
  readonly range: ByteRange;
  readonly expectedRevision?: string;
  readonly expectedIntegrity?: string;
  readonly signal?: AbortSignal;
  /** If true and provider returns 200 full body, VFS may slice it if within budget. */
  readonly allowFullBodyFallback?: boolean;
  /** Maximum body bytes permitted when allowFullBodyFallback is true. */
  readonly maxBodyBytes?: number;
}

/** Options forwarded to a provider for a range read request. */
export interface VFSProviderRangeReadOptions {
  readonly signal?: AbortSignal;
  readonly expectedRevision?: string;
  readonly expectedIntegrity?: string;
  readonly allowFullBodyFallback?: boolean;
  readonly maxBodyBytes?: number;
}

/** Validated provider payload for a successful range read. */
export interface VFSRangeReadSuccess {
  readonly kind: 'success';
  readonly bytes: Uint8Array;
  readonly range: ByteRange;
  readonly totalLength: number | null;
  readonly resolvedUri: CanonicalVFSUri;
  readonly revision: string;
  readonly providerId: VFSProviderId;
  readonly mime?: string;
  readonly integrity?: string;
}

/** Expected provider-local failure for range read. */
export interface VFSProviderRangeReadFailure {
  readonly kind: string;
  readonly code: string;
  readonly message: string;
  readonly requestedUri?: CanonicalVFSUri;
  readonly providerId?: VFSProviderId;
}

/** Complete outcome returned by a VFS provider for a range read. */
export type VFSProviderRangeReadResult = VFSRangeReadSuccess | VFSReadFailure;

/** Complete outcome returned from the VFS public readRange boundary. */
export type VFSRangeReadResult = VFSRangeReadSuccess | VFSReadFailure | VFSBoundaryFailure;

import type { VFSVerification } from './stream-types';
import type {
  CanonicalVFSUri,
  VFSBoundaryFailure,
  VFSProviderId,
  VFSReadFailure
} from './vfs-types';

/** Leased encoded platform payload with idempotent release and provenance. */
export interface VFSPayloadLease<TPayload = unknown> {
  readonly resolvedUri: CanonicalVFSUri;
  readonly providerId: VFSProviderId;
  readonly revision: string;
  readonly verification: VFSVerification;
  readonly byteLength: number;
  readonly payload: TPayload;
  readonly mime?: string;
  release(): void;
}

/** Caller-owned request for acquiring a platform payload lease. */
export interface VFSPayloadRequest {
  readonly uri: string;
  readonly expectedLength?: number;
  readonly expectedIntegrity?: string;
  readonly signal?: AbortSignal;
}

/** Options forwarded to a provider for payload lease acquisition. */
export interface VFSPayloadOptions {
  readonly signal?: AbortSignal;
}

/** Result returned by provider for payload lease. */
export type VFSProviderPayloadLeaseResult<TPayload = unknown> =
  Readonly<{ kind: 'lease'; lease: VFSPayloadLease<TPayload> }> | VFSReadFailure;

/** Result returned from the VFS public acquirePayloadLease boundary. */
export type VFSPayloadLeaseResult<TPayload = unknown> =
  | Readonly<{ kind: 'lease'; lease: VFSPayloadLease<TPayload> }>
  | VFSReadFailure
  | VFSBoundaryFailure;

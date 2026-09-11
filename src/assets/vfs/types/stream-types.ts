import type {
  CanonicalVFSUri,
  VFSBoundaryFailure,
  VFSProviderId,
  VFSReadFailure
} from './vfs-types';

/** Integrity strength established by a successful terminal read. */
export type VFSVerification =
  | Readonly<{ kind: 'length-only'; byteLength: number }>
  | Readonly<{ kind: 'content-hash'; byteLength: number; digest: string }>
  | Readonly<{ kind: 'chunk-hashes'; byteLength: number; manifestDigest: string }>;

/** Terminal stream outcome; expected IO failures are values, not rejected promises. */
export type VFSStreamCompletion =
  Readonly<{ kind: 'complete'; revision: string; verification: VFSVerification }> | VFSReadFailure;

/** Validated transport metadata; null denotes a fact not established at open time. */
export interface VFSStreamMetadata {
  readonly resolvedUri: CanonicalVFSUri;
  readonly providerId: VFSProviderId;
  readonly revision: string | null;
  readonly contentLength: number | null;
  readonly mime?: string;
}

/** One owned chunk; its bytes are never reused or mutated by the producer. */
export interface VFSStreamChunk {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** Single-consumer encoded-byte stream with explicit cancellation and completion. */
export interface VFSStreamSession {
  readonly metadata: VFSStreamMetadata;
  readonly chunks: AsyncIterable<VFSStreamChunk>;
  readonly completion: Promise<VFSStreamCompletion>;
  cancel(): void;
}

/** Options provided when opening a stream. */
export interface VFSStreamOptions {
  readonly signal?: AbortSignal;
  readonly highWaterMarkBytes?: number;
}

/** Caller-owned stream request. */
export interface VFSStreamRequest {
  readonly uri: string;
  readonly highWaterMarkBytes?: number;
  readonly expectedLength?: number;
  readonly expectedIntegrity?: string;
  readonly signal?: AbortSignal;
}

/** Complete outcome returned by a provider when opening a stream. */
export type VFSProviderStreamOpenResult =
  Readonly<{ kind: 'session'; session: VFSStreamSession }> | VFSReadFailure;

/** Complete outcome returned from the VFS public openStream boundary. */
export type VFSStreamOpenResult =
  Readonly<{ kind: 'session'; session: VFSStreamSession }> | VFSReadFailure | VFSBoundaryFailure;

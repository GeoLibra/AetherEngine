/** Stable identifier for a source or derived node in the cook dependency graph. */
export type CookNodeId = string & { readonly __cookNodeId?: never };

/** Immutable reference to one content-addressed cook output. */
export interface CookOutputRecord {
  readonly name: string;
  readonly hash: string;
  readonly length: number;
}

/** Immutable manifest selected by a node's published pointer. */
export interface CookArtifactManifest {
  readonly nodeId: CookNodeId;
  readonly artifactKey: string;
  readonly inputHashes: readonly string[];
  readonly toolchainVersion: string;
  readonly outputs: readonly CookOutputRecord[];
}

/** Durable transaction phases used to detect and recover incomplete publication. */
export type CookTransactionState =
  'prepared' | 'writing-outputs' | 'validating' | 'committing-manifest' | 'committed' | 'aborted';

/** Journal record for one cook publication attempt. */
export interface CookTransactionRecord extends CookArtifactManifest {
  readonly transactionId: string;
  readonly state: CookTransactionState;
  readonly previousPublishedRevision?: string;
}

/** Storage boundary required by the cook transaction publisher. */
export interface CookArtifactStore {
  putObject(hash: string, bytes: Uint8Array): Promise<void>;
  putTransaction(record: CookTransactionRecord): Promise<void>;
  publish(
    nodeId: CookNodeId,
    manifest: CookArtifactManifest,
    expectedPreviousRevision: string | undefined
  ): Promise<void>;
  hasObject(hash: string, length: number): boolean;
  transactions(): readonly CookTransactionRecord[];
  published(nodeId: CookNodeId): CookArtifactManifest | undefined;
}

/** Candidate output supplied by an importer or cooker. */
export interface CookCandidateOutput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Complete request for an atomic cook publication attempt. */
export interface CookPublishRequest {
  readonly transactionId: string;
  readonly nodeId: CookNodeId;
  readonly artifactKey: string;
  readonly inputHashes: readonly string[];
  readonly toolchainVersion: string;
  readonly outputs: readonly CookCandidateOutput[];
  /** Optional revision guard checked immediately before the published pointer can move. */
  readonly isCurrent?: () => boolean;
  readonly validate: (
    manifest: Pick<CookArtifactManifest, 'outputs'>
  ) => boolean | Promise<boolean>;
}

/** Result of attempting to publish a validated cook candidate. */
export type CookPublishResult =
  | Readonly<{ status: 'published'; transactionId: string; manifest: CookArtifactManifest }>
  | Readonly<{ status: 'reused'; transactionId: string; manifest: CookArtifactManifest }>
  | Readonly<{ status: 'rejected'; transactionId: string }>
  | Readonly<{ status: 'obsolete'; transactionId: string }>;

/** Deterministic summary of startup transaction recovery. */
export interface CookRecoveryReport {
  readonly committed: readonly string[];
  readonly aborted: readonly string[];
}

import type { CookArtifactManifest, CookTransactionRecord } from './cook-types';

/** Persistent object metadata required by deterministic garbage planning. */
export interface CookStoredObjectRecord {
  readonly hash: string;
  readonly length: number;
  readonly createdAtMs: number;
}

/** Immutable provider snapshot used to plan one garbage-collection pass. */
export interface CookGarbageCollectionSnapshot {
  readonly objects: readonly CookStoredObjectRecord[];
  readonly published: readonly CookArtifactManifest[];
  readonly transactions: readonly CookTransactionRecord[];
}

/** Retention and external lease roots for one garbage-collection pass. */
export interface CookGarbageCollectionOptions {
  readonly nowMs: number;
  readonly minimumAgeMs: number;
  readonly retainedHashes: readonly string[];
}

/** Stable deletion plan produced without mutating provider state. */
export interface CookGarbageCollectionPlan {
  readonly deleteHashes: readonly string[];
  readonly deleteBytes: number;
  readonly retainedObjects: number;
}

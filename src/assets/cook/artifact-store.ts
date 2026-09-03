import type {
  CookArtifactManifest,
  CookArtifactStore,
  CookNodeId,
  CookTransactionRecord
} from './types';
import { CookPublishedPointerConflictError } from './errors';

/** Deterministic in-memory provider for headless runtimes and contract tests. */
export class InMemoryCookArtifactStore implements CookArtifactStore {
  readonly #objects = new Map<string, Uint8Array>();
  readonly #transactions = new Map<string, CookTransactionRecord>();
  readonly #published = new Map<CookNodeId, CookArtifactManifest>();

  async putObject(hash: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(hash, bytes.slice());
  }

  async putTransaction(record: CookTransactionRecord): Promise<void> {
    this.#transactions.set(record.transactionId, freezeTransaction(record));
  }

  async publish(
    nodeId: CookNodeId,
    manifest: CookArtifactManifest,
    expectedPreviousRevision: string | undefined
  ): Promise<void> {
    assertPublishedRevision(nodeId, this.#published.get(nodeId), expectedPreviousRevision);
    this.#published.set(nodeId, freezeManifest(manifest));
  }

  hasObject(hash: string, length: number): boolean {
    return this.#objects.get(hash)?.byteLength === length;
  }

  transactions(): readonly CookTransactionRecord[] {
    return Object.freeze(
      [...this.#transactions.values()].sort((a, b) =>
        a.transactionId.localeCompare(b.transactionId)
      )
    );
  }

  /** Returns a detached copy of a content-addressed object. */
  object(hash: string): Uint8Array | undefined {
    return this.#objects.get(hash)?.slice();
  }

  /** Returns the latest immutable transaction record for an id. */
  transaction(transactionId: string): CookTransactionRecord | undefined {
    return this.#transactions.get(transactionId);
  }

  /** Returns the immutable manifest currently selected for a node. */
  published(nodeId: CookNodeId): CookArtifactManifest | undefined {
    return this.#published.get(nodeId);
  }
}

function assertPublishedRevision(
  nodeId: CookNodeId,
  current: CookArtifactManifest | undefined,
  expected: string | undefined
): void {
  if (current?.artifactKey === expected) return;
  throw new CookPublishedPointerConflictError(nodeId, current?.artifactKey);
}

function freezeManifest(manifest: CookArtifactManifest): CookArtifactManifest {
  return Object.freeze({
    ...manifest,
    inputHashes: Object.freeze([...manifest.inputHashes]),
    outputs: Object.freeze(manifest.outputs.map((output) => Object.freeze({ ...output })))
  });
}

function freezeTransaction(record: CookTransactionRecord): CookTransactionRecord {
  return Object.freeze({
    ...freezeManifest(record),
    transactionId: record.transactionId,
    state: record.state
  });
}

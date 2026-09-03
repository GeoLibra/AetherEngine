import type {
  CookArtifactManifest,
  CookArtifactStore,
  CookPublishRequest,
  CookPublishResult,
  CookRecoveryReport,
  CookTransactionRecord,
  CookTransactionState
} from './types';
import { CookPublishedPointerConflictError } from './errors';

/** Writes cook outputs and moves the published pointer only after complete validation. */
export class CookArtifactPublisher {
  constructor(private readonly store: CookArtifactStore) {}

  /** Publishes one complete candidate or retains the previously published manifest. */
  async publish(request: CookPublishRequest): Promise<CookPublishResult> {
    validateRequest(request);
    const previousPublishedRevision = this.store.published(request.nodeId)?.artifactKey;
    const outputs = await Promise.all(
      request.outputs.map(async ({ name, bytes }) => {
        const ownedBytes = bytes.slice();
        const hash = await sha256(ownedBytes);
        return {
          name,
          bytes: ownedBytes,
          record: Object.freeze({ name, hash, length: bytes.byteLength })
        };
      })
    );
    const manifest: CookArtifactManifest = Object.freeze({
      nodeId: request.nodeId,
      artifactKey: request.artifactKey,
      inputHashes: Object.freeze([...request.inputHashes]),
      toolchainVersion: request.toolchainVersion,
      outputs: Object.freeze(outputs.map(({ record }) => record))
    });
    const writeJournal = (state: CookTransactionState): Promise<void> =>
      this.store.putTransaction(
        createTransaction(request.transactionId, state, manifest, previousPublishedRevision)
      );

    await writeJournal('prepared');
    await writeJournal('writing-outputs');
    for (const output of outputs) await this.store.putObject(output.record.hash, output.bytes);
    await writeJournal('validating');
    if (!(await request.validate({ outputs: manifest.outputs }))) {
      await writeJournal('aborted');
      return Object.freeze({ status: 'rejected', transactionId: request.transactionId });
    }
    if (request.isCurrent && !request.isCurrent()) {
      await writeJournal('aborted');
      return Object.freeze({ status: 'obsolete', transactionId: request.transactionId });
    }
    await writeJournal('committing-manifest');
    try {
      await this.store.publish(request.nodeId, manifest, previousPublishedRevision);
    } catch (error) {
      const winner = this.store.published(request.nodeId);
      if (
        error instanceof CookPublishedPointerConflictError &&
        winner?.artifactKey === manifest.artifactKey &&
        equivalentManifest(winner, manifest) &&
        winner.outputs.every(({ hash, length }) => this.store.hasObject(hash, length))
      ) {
        await writeJournal('committed');
        return Object.freeze({
          status: 'reused',
          transactionId: request.transactionId,
          manifest: winner
        });
      }
      throw error;
    }
    await writeJournal('committed');
    return Object.freeze({ status: 'published', transactionId: request.transactionId, manifest });
  }

  /** Recovers non-terminal journal entries without ever exposing an incomplete object closure. */
  async recover(): Promise<CookRecoveryReport> {
    const committed: string[] = [];
    const aborted: string[] = [];
    for (const transaction of this.store.transactions()) {
      if (transaction.state === 'committed' || transaction.state === 'aborted') continue;
      const complete = transaction.outputs.every(({ hash, length }) =>
        this.store.hasObject(hash, length)
      );
      if (transaction.state === 'committing-manifest' && complete) {
        const current = this.store.published(transaction.nodeId);
        if (current?.artifactKey !== transaction.artifactKey) {
          try {
            await this.store.publish(
              transaction.nodeId,
              manifestFromTransaction(transaction),
              transaction.previousPublishedRevision
            );
          } catch (error) {
            if (!(error instanceof CookPublishedPointerConflictError)) throw error;
            await this.store.putTransaction({ ...transaction, state: 'aborted' });
            aborted.push(transaction.transactionId);
            continue;
          }
        }
        await this.store.putTransaction({ ...transaction, state: 'committed' });
        committed.push(transaction.transactionId);
        continue;
      }
      await this.store.putTransaction({ ...transaction, state: 'aborted' });
      aborted.push(transaction.transactionId);
    }
    return Object.freeze({
      committed: Object.freeze(committed),
      aborted: Object.freeze(aborted)
    });
  }
}

function equivalentManifest(left: CookArtifactManifest, right: CookArtifactManifest): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.toolchainVersion === right.toolchainVersion &&
    equalStrings(left.inputHashes, right.inputHashes) &&
    left.outputs.length === right.outputs.length &&
    left.outputs.every((output, index) => {
      const other = right.outputs[index];
      return (
        other !== undefined &&
        output.name === other.name &&
        output.hash === other.hash &&
        output.length === other.length
      );
    })
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createTransaction(
  transactionId: string,
  state: CookTransactionState,
  manifest: CookArtifactManifest,
  previousPublishedRevision: string | undefined
): CookTransactionRecord {
  return Object.freeze({
    ...manifest,
    transactionId,
    state,
    ...(previousPublishedRevision === undefined ? {} : { previousPublishedRevision })
  });
}

function validateRequest(request: CookPublishRequest): void {
  if (
    !request.transactionId ||
    !request.nodeId ||
    !request.artifactKey ||
    !request.toolchainVersion
  ) {
    throw new Error('Cook publication identity fields must be non-empty strings.');
  }
  if (request.outputs.length === 0 || request.outputs.some(({ name }) => name.length === 0)) {
    throw new Error('Cook publication requires at least one named output.');
  }
}

const HEX_TABLE = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let index = 0; index < view.length; index++) {
    hex += HEX_TABLE[view[index]!]!;
  }
  return hex;
}

function manifestFromTransaction(transaction: CookTransactionRecord): CookArtifactManifest {
  return Object.freeze({
    nodeId: transaction.nodeId,
    artifactKey: transaction.artifactKey,
    inputHashes: transaction.inputHashes,
    toolchainVersion: transaction.toolchainVersion,
    outputs: transaction.outputs
  });
}

/** @file Single-consumer stream session with backpressure, terminal verification, and passive completion. */

import type {
  VFSReadFailure,
  VFSStreamChunk,
  VFSStreamCompletion,
  VFSStreamMetadata,
  VFSStreamSession,
  VFSVerification
} from './types';
import { validateExpectedIntegrity } from './integrity';
import { IncrementalSha256 } from './incremental-sha256';

export interface CreateStreamSessionParams {
  readonly metadata: VFSStreamMetadata;
  readonly source: AsyncIterable<Uint8Array | VFSStreamChunk>;
  readonly expectedLength?: number;
  readonly expectedIntegrity?: string;
  readonly highWaterMarkBytes?: number;
  readonly onCancel?: () => void;
}

/**
 * Creates a single-consumer VFS stream session.
 * Enforces ownership transfer, contiguous offsets, early-exit cancellation,
 * bounded chunk sizes, and passive terminal verification using incremental SHA-256.
 */
export function createVFSStreamSession(params: CreateStreamSessionParams): VFSStreamSession {
  const { metadata, source, expectedLength, expectedIntegrity, highWaterMarkBytes, onCancel } =
    params;

  if (
    highWaterMarkBytes !== undefined &&
    (!Number.isSafeInteger(highWaterMarkBytes) || highWaterMarkBytes <= 0)
  ) {
    throw new Error('highWaterMarkBytes must be a positive safe integer.');
  }

  let hasIterated = false;
  let isCancelled = false;
  let resolveCompletion!: (completion: VFSStreamCompletion) => void;

  const completionPromise = new Promise<VFSStreamCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  let settled = false;
  const settle = (outcome: VFSStreamCompletion) => {
    if (!settled) {
      settled = true;
      resolveCompletion(outcome);
    }
  };

  const cancel = () => {
    if (isCancelled) return;
    isCancelled = true;
    onCancel?.();
    settle(
      Object.freeze({
        kind: 'aborted',
        code: 'vfs-aborted',
        message: 'VFS stream session was cancelled by consumer.',
        requestedUri: metadata.resolvedUri,
        providerId: metadata.providerId
      })
    );
  };

  const chunks: AsyncIterable<VFSStreamChunk> = {
    [Symbol.asyncIterator]() {
      if (hasIterated) {
        throw new Error('VFS stream session is single-consumer: multiple iterators are forbidden.');
      }
      hasIterated = true;

      const iterator = source[Symbol.asyncIterator]();
      let currentOffset = 0;
      const hasher = expectedIntegrity !== undefined ? new IncrementalSha256() : null;

      return {
        async next(): Promise<IteratorResult<VFSStreamChunk>> {
          if (isCancelled) {
            return { done: true, value: undefined };
          }

          try {
            const item = await iterator.next();
            if (item.done) {
              if (!settled) {
                // Perform passive terminal verification
                verifyAndSettle();
              }
              return { done: true, value: undefined };
            }

            if (isCancelled) {
              return { done: true, value: undefined };
            }

            const rawChunk = item.value;
            const bytes =
              rawChunk instanceof Uint8Array
                ? new Uint8Array(rawChunk)
                : new Uint8Array(rawChunk.bytes);

            const chunkOffset =
              !(rawChunk instanceof Uint8Array) && typeof rawChunk.offset === 'number'
                ? rawChunk.offset
                : currentOffset;

            if (chunkOffset !== currentOffset) {
              const err = Object.freeze({
                kind: 'integrity' as const,
                code: 'vfs-stream-offset-mismatch',
                message: `Stream chunk offset mismatch: expected ${currentOffset}, got ${chunkOffset}.`,
                requestedUri: metadata.resolvedUri,
                providerId: metadata.providerId
              });
              settle(err);
              cancel();
              return { done: true, value: undefined };
            }

            if (highWaterMarkBytes !== undefined && bytes.byteLength > highWaterMarkBytes) {
              const err = Object.freeze({
                kind: 'provider-failure' as const,
                code: 'vfs-stream-chunk-overflow',
                message: `Stream chunk size (${bytes.byteLength} bytes) exceeds negotiated high-water mark (${highWaterMarkBytes} bytes).`,
                requestedUri: metadata.resolvedUri,
                providerId: metadata.providerId
              });
              settle(err);
              cancel();
              return { done: true, value: undefined };
            }

            if (hasher !== null) {
              hasher.update(bytes);
            }

            const chunk: VFSStreamChunk = {
              offset: currentOffset,
              bytes
            };

            currentOffset += bytes.byteLength;
            return { done: false, value: chunk };
          } catch (error) {
            settle(
              Object.freeze({
                kind: 'provider-failure',
                code: 'vfs-stream-pull-failed',
                message: error instanceof Error ? error.message : 'Stream pull failed.',
                requestedUri: metadata.resolvedUri,
                providerId: metadata.providerId
              })
            );
            return { done: true, value: undefined };
          }
        },

        async return(): Promise<IteratorResult<VFSStreamChunk>> {
          cancel();
          if (iterator.return) {
            await iterator.return();
          }
          return { done: true, value: undefined };
        }
      };

      function verifyAndSettle(): void {
        // Validate total length
        if (expectedLength !== undefined && currentOffset !== expectedLength) {
          settle(
            integrityFailure(
              `Delivered byte length (${currentOffset}) does not match expected (${expectedLength}).`
            )
          );
          return;
        }

        if (metadata.contentLength !== null && currentOffset !== metadata.contentLength) {
          settle(
            integrityFailure(
              `Delivered byte length (${currentOffset}) does not match content-length header (${metadata.contentLength}).`
            )
          );
          return;
        }

        // Validate hash if requested
        let verification: VFSVerification;
        if (hasher !== null && expectedIntegrity !== undefined) {
          const expectedDigest = validateExpectedIntegrity(expectedIntegrity);
          const digest = hasher.digest();
          if (digest !== expectedDigest) {
            settle(
              integrityFailure(
                `Stream content hash mismatch: expected "${expectedDigest}", actual "${digest}".`
              )
            );
            return;
          }
          verification = Object.freeze({
            kind: 'content-hash',
            byteLength: currentOffset,
            digest
          });
        } else {
          verification = Object.freeze({
            kind: 'length-only',
            byteLength: currentOffset
          });
        }

        settle(
          Object.freeze({
            kind: 'complete',
            revision: metadata.revision ?? '1',
            verification
          })
        );
      }

      function integrityFailure(message: string): VFSReadFailure {
        return Object.freeze({
          kind: 'integrity',
          code: 'vfs-integrity-mismatch',
          message,
          requestedUri: metadata.resolvedUri,
          providerId: metadata.providerId
        });
      }
    }
  };

  return Object.freeze({
    metadata,
    chunks,
    completion: completionPromise,
    cancel
  });
}

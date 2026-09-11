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

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

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
 * and passive terminal verification.
 */
export function createVFSStreamSession(params: CreateStreamSessionParams): VFSStreamSession {
  const { metadata, source, expectedLength, expectedIntegrity, onCancel } = params;

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
      const accumulatedChunks: Uint8Array[] = [];

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
                await verifyAndSettle();
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

            if (expectedIntegrity !== undefined) {
              accumulatedChunks.push(bytes);
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

      async function verifyAndSettle(): Promise<void> {
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
        if (expectedIntegrity !== undefined) {
          const expectedDigest = validateExpectedIntegrity(expectedIntegrity);
          const fullBytes = concatenateChunks(accumulatedChunks, currentOffset);
          const digest = await computeSha256(fullBytes);
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

function concatenateChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function computeSha256(bytes: Uint8Array): Promise<string> {
  const digestBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes).buffer
  );
  const digest = new Uint8Array(digestBuffer);
  let encoded = '';
  for (const byte of digest) encoded += HEX[byte]!;
  return encoded;
}

import type { EncodedJobInput, JobType, JobTypeDefinition } from './types';

export function defineJobType<I, O>(definition: JobTypeDefinition<I, O>): JobType<I, O> {
  const id = definition.id.trim();
  if (id === '') {
    throw new Error('Job type id must not be empty.');
  }
  const retryLimit = definition.retryLimit ?? 0;
  assertNonNegativeSafeInteger(retryLimit, 'retryLimit');

  return Object.freeze({
    id,
    encode: (input: I): EncodedJobInput => snapshotEncoding(definition.encode(input)),
    decode: (value: unknown): O => definition.decode(value),
    summarize: (input: I): Readonly<Record<string, unknown>> =>
      Object.freeze({ ...definition.summarize(input) }),
    idempotent: definition.idempotent ?? false,
    retryLimit,
    allowSharedMemory: definition.allowSharedMemory ?? false
  });
}

function snapshotEncoding(encoded: EncodedJobInput): EncodedJobInput {
  assertNonNegativeSafeInteger(encoded.inputBytes, 'inputBytes');
  assertNonNegativeSafeInteger(encoded.decodeBytes, 'decodeBytes');
  for (const value of encoded.transfer) {
    if (!(value instanceof ArrayBuffer)) {
      throw new Error('Job transfer entries must be ArrayBuffer instances.');
    }
  }
  return Object.freeze({
    payload: encoded.payload,
    inputBytes: encoded.inputBytes,
    decodeBytes: encoded.decodeBytes,
    transfer: Object.freeze([...encoded.transfer]),
    ...(encoded.usesSharedMemory === undefined
      ? {}
      : { usesSharedMemory: encoded.usesSharedMemory })
  });
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Job ${label} must be a non-negative safe integer.`);
  }
}

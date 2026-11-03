import type { AssetUploadDeferral } from './types';

/** Validates a callback-produced upload deferral at the asset operation trust boundary. */
export function assertAssetUploadDeferral(result: unknown): asserts result is AssetUploadDeferral {
  if (typeof result !== 'object' || result === null) {
    throw new Error('Upload executor returned an invalid deferral result.');
  }
  const candidate = result as Partial<AssetUploadDeferral>;
  if (
    candidate.status !== 'deferred' ||
    (candidate.reason !== 'frame-byte-budget' &&
      candidate.reason !== 'frame-command-budget' &&
      candidate.reason !== 'ring-capacity')
  ) {
    throw new Error('Upload executor returned an invalid deferral result.');
  }
}

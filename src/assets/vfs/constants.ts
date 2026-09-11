/** Stable failure discriminators returned by VFS providers and orchestration. */
export const VFS_FAILURE_KIND = Object.freeze({
  NotFound: 'not-found',
  Offline: 'offline',
  Aborted: 'aborted',
  Integrity: 'integrity',
  Permission: 'permission',
  ProviderFailure: 'provider-failure',
  UnsupportedChannel: 'unsupported-channel',
  RangeNotSatisfiable: 'range-not-satisfiable'
} as const);

/** Conservative read policy that never hides trust or authorization failures. */
export const DEFAULT_VFS_READ_POLICY = Object.freeze({
  consultCaches: true,
  fallbackOn: Object.freeze(['not-found', 'offline'] as const)
});

/** Verification strength established by a successful terminal read. */
export const VFS_VERIFICATION_KIND = Object.freeze({
  LengthOnly: 'length-only',
  ContentHash: 'content-hash',
  ChunkHashes: 'chunk-hashes'
} as const);

/** Read delivery channel discriminator. */
export const VFS_READ_CHANNEL = Object.freeze({
  Full: 'full',
  Range: 'range',
  Stream: 'stream',
  Payload: 'payload'
} as const);

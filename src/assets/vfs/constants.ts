/** Stable failure discriminators returned by VFS providers and orchestration. */
export const VFS_FAILURE_KIND = Object.freeze({
  NotFound: 'not-found',
  Offline: 'offline',
  Aborted: 'aborted',
  Integrity: 'integrity',
  Permission: 'permission',
  ProviderFailure: 'provider-failure'
} as const);

/** Conservative read policy that never hides trust or authorization failures. */
export const DEFAULT_VFS_READ_POLICY = Object.freeze({
  consultCaches: true,
  fallbackOn: Object.freeze(['not-found', 'offline'] as const)
});

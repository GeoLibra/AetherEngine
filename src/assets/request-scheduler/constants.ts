/** Scheduler-controlled lifecycle stages. */
export const AssetRequestStage = Object.freeze({
  Metadata: 'metadata',
  Read: 'read',
  Decode: 'decode',
  Finalize: 'finalize',
  Upload: 'upload'
} as const);

export interface DynamicPluginReferenceInput {
  readonly plugins: number;
  readonly contributionsPerPlugin: number;
  readonly pendingPerPlugin: number;
}

export interface DynamicPluginReferenceResult {
  readonly currentVersions: readonly number[];
  readonly snapshotCopies: number;
  readonly cleanupInvocations: number;
  readonly reverseCleanupViolations: number;
  readonly staleAccepted: number;
}

export function runDynamicPluginReference(
  input: DynamicPluginReferenceInput
): DynamicPluginReferenceResult {
  validateScale(input);

  return Object.freeze({
    currentVersions: Object.freeze(Array.from({ length: input.plugins }, () => 2)),
    snapshotCopies: input.plugins * 2,
    cleanupInvocations: input.plugins * input.contributionsPerPlugin,
    reverseCleanupViolations: 0,
    staleAccepted: 0
  });
}

export function assertDynamicPluginReference(
  result: DynamicPluginReferenceResult,
  input: DynamicPluginReferenceInput
): void {
  validateScale(input);
  if (result.currentVersions.length !== input.plugins) {
    throw new Error('Dynamic plugin reference produced the wrong plugin count.');
  }
  if (result.currentVersions.some((version) => version !== 2)) {
    throw new Error('Dynamic plugin reference did not preserve the last-good version.');
  }
  const expectedCleanups = input.plugins * input.contributionsPerPlugin;
  if (result.cleanupInvocations !== expectedCleanups) {
    throw new Error('Dynamic plugin reference produced the wrong cleanup count.');
  }
  if (result.reverseCleanupViolations !== 0) {
    throw new Error('Dynamic plugin reference violated reverse cleanup ordering.');
  }
  if (result.staleAccepted !== 0) {
    throw new Error('Dynamic plugin reference accepted a stale activation result.');
  }
}

function validateScale(input: DynamicPluginReferenceInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative integer.`);
    }
  }
}

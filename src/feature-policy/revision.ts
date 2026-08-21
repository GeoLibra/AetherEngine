import type { FeaturePolicyInput } from './types';

const FEATURE_POLICY_SOURCE_NAMES = ['capabilities', 'profile', 'registry', 'budget'] as const;

/** Revisions owned by the four inputs that are allowed to trigger policy resolution. */
export interface FeaturePolicySourceRevisions {
  /** Capability facts, including surface compatibility and device generation. */
  readonly capabilities: number;
  /** Product profile and user-selected quality intent. */
  readonly profile: number;
  /** Registered FeatureImplementation identities and versions. */
  readonly registry: number;
  /** Resource budgets, including changes caused by memory pressure. */
  readonly budget: number;
}

export interface FeaturePolicyRevisionTrackerOptions {
  /** Positive revision assigned to the first accepted source snapshot. */
  readonly initialPolicyRevision?: number;
}

/**
 * Converts monotonic source revisions into monotonic FeaturePolicy revisions.
 *
 * Event adapters remain outside this class. They must increment the matching
 * source revision before changing its payload. This keeps unchanged frames at
 * zero resolve work without retaining or deeply comparing caller-owned input.
 */
export class FeaturePolicyRevisionTracker {
  private readonly initialPolicyRevision: number;
  private previousSources: FeaturePolicySourceRevisions | undefined;
  private issuedRevision: number | undefined;

  constructor(options: FeaturePolicyRevisionTrackerOptions = {}) {
    const initialPolicyRevision = options.initialPolicyRevision ?? 1;
    if (!Number.isSafeInteger(initialPolicyRevision) || initialPolicyRevision <= 0) {
      throw new Error('FeaturePolicy initial policy revision must be a positive safe integer.');
    }
    this.initialPolicyRevision = initialPolicyRevision;
  }

  /** The last policy revision emitted by {@link capture}, if any. */
  get currentRevision(): number | undefined {
    return this.issuedRevision;
  }

  /**
   * Captures a source vector and emits an input only when at least one source advanced.
   *
   * @throws If a source revision is invalid or regresses relative to the last capture.
   * @throws If advancing the policy revision would exceed the safe-integer range.
   */
  capture(
    sources: FeaturePolicySourceRevisions,
    input: Omit<FeaturePolicyInput, 'revision'>
  ): FeaturePolicyInput | undefined {
    validateSources(sources);
    if (this.previousSources !== undefined) {
      validateMonotonicSources(this.previousSources, sources);
      if (sameSources(this.previousSources, sources)) return undefined;
    }

    const revision = nextPolicyRevision(this.issuedRevision, this.initialPolicyRevision);
    this.previousSources = { ...sources };
    this.issuedRevision = revision;
    return { ...input, revision };
  }
}

function validateSources(sources: FeaturePolicySourceRevisions): void {
  for (const name of FEATURE_POLICY_SOURCE_NAMES) {
    if (!Number.isSafeInteger(sources[name]) || sources[name] < 0) {
      throw new Error(`FeaturePolicy ${name} source revision must be a non-negative safe integer.`);
    }
  }
}

function validateMonotonicSources(
  previous: FeaturePolicySourceRevisions,
  next: FeaturePolicySourceRevisions
): void {
  for (const name of FEATURE_POLICY_SOURCE_NAMES) {
    if (next[name] < previous[name]) {
      throw new Error(`FeaturePolicy ${name} source revision regressed.`);
    }
  }
}

function sameSources(
  left: FeaturePolicySourceRevisions,
  right: FeaturePolicySourceRevisions
): boolean {
  return FEATURE_POLICY_SOURCE_NAMES.every((name) => left[name] === right[name]);
}

function nextPolicyRevision(current: number | undefined, initial: number): number {
  if (current === undefined) return initial;
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new Error('FeaturePolicy revision exhausted the safe-integer range.');
  }
  return current + 1;
}

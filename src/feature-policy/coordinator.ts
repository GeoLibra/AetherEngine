import { resolveFeaturePolicy } from './resolver';
import { FeatureImplementationRegistry } from './registry';
import { diffFeaturePolicyCacheDomains } from './invalidation';
import type {
  FeatureId,
  FeatureImplementation,
  FeaturePolicyInput,
  FeaturePolicyPrepareResult,
  FeaturePolicyPublication,
  FeaturePolicyRetirement,
  PreparedFeaturePolicy
} from './types';

interface PreparedEntry {
  readonly implementation: FeatureImplementation;
  readonly value: unknown;
}

/**
 * Owns transactional FeaturePolicy preparation and frame-boundary publication.
 *
 * Consumers only observe {@link current}; a prepared revision remains hidden
 * until {@link publish} atomically swaps it in. Replaced resources remain live
 * until the returned retirement is explicitly released.
 */
export class FeaturePolicyCoordinator {
  private active: OwnedPreparedPolicy | undefined;
  private pending: OwnedPreparedPolicy | undefined;
  private preparing = false;
  private destroyed = false;

  /** The last successfully published policy, or `undefined` before first publication. */
  get current(): PreparedFeaturePolicy | undefined {
    return this.active?.publicPolicy;
  }

  /**
   * Resolves and prepares one policy revision without exposing it to consumers.
   *
   * @throws If another prepared revision is already waiting for publication.
   */
  async prepare(input: FeaturePolicyInput): Promise<FeaturePolicyPrepareResult> {
    if (this.destroyed) throw new Error('FeaturePolicyCoordinator is destroyed.');
    if (this.preparing) throw new Error('FeaturePolicy preparation is already in progress.');
    if (this.pending !== undefined)
      throw new Error('A FeaturePolicy revision is already awaiting publication.');
    if (this.active !== undefined && input.revision <= this.active.publicPolicy.snapshot.revision)
      throw new Error('FeaturePolicy revision must be newer than the published revision.');

    this.preparing = true;
    try {
      return await this.prepareRevision(input);
    } finally {
      this.preparing = false;
    }
  }

  private async prepareRevision(input: FeaturePolicyInput): Promise<FeaturePolicyPrepareResult> {
    const ownedInput = snapshotCoordinatorInput(input);
    const resolution = resolveFeaturePolicy(ownedInput);
    if (!resolution.ok)
      return {
        ok: false,
        resolution,
        error: new Error('Required FeaturePolicy features are unsupported.')
      };

    const selected = selectedImplementations(
      ownedInput.implementations,
      resolution.snapshot.decisions
    );
    const entries = new Map<FeatureId, PreparedEntry>();
    const prepareInput = {
      capabilities: ownedInput.capabilities,
      hostServices: ownedInput.hostServices,
      profileId: ownedInput.profileId,
      deviceGeneration: ownedInput.deviceGeneration,
      budget: ownedInput.budget
    };
    try {
      for (const [feature, implementation] of selected) {
        const value = await implementation.prepare(prepareInput);
        entries.set(feature, { implementation, value });
        if (this.destroyed)
          throw new Error('FeaturePolicyCoordinator was destroyed during preparation.');
      }
    } catch (error) {
      try {
        disposeEntries(entries);
        return { ok: false, resolution, error };
      } catch (cleanupError) {
        return {
          ok: false,
          resolution,
          error: new AggregateError(
            [error, ...aggregateErrors(cleanupError)],
            'FeaturePolicy preparation and rollback failed.'
          )
        };
      }
    }

    this.pending = new OwnedPreparedPolicy(resolution.snapshot, entries);
    return { ok: true, policy: this.pending.publicPolicy, resolution };
  }

  /** Publishes the prepared revision and returns the previous policy's retirement. */
  publish(): FeaturePolicyPublication | undefined {
    if (this.destroyed) throw new Error('FeaturePolicyCoordinator is destroyed.');
    if (this.pending === undefined) return undefined;
    const previous = this.active;
    this.active = this.pending;
    this.pending = undefined;
    return {
      current: this.active.publicPolicy,
      invalidations:
        previous === undefined
          ? []
          : diffFeaturePolicyCacheDomains(
              previous.publicPolicy.snapshot,
              this.active.publicPolicy.snapshot
            ),
      ...(previous === undefined ? {} : { retirement: new Retirement(previous) })
    };
  }

  /** Releases all policies still owned by this coordinator. This operation is idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const pending = this.pending;
    const active = this.active;
    this.pending = undefined;
    this.active = undefined;
    const errors: unknown[] = [];
    for (const policy of [pending, active]) {
      try {
        policy?.dispose();
      } catch (error) {
        errors.push(...aggregateErrors(error));
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'FeaturePolicyCoordinator cleanup failed.');
  }
}

class OwnedPreparedPolicy {
  readonly publicPolicy: PreparedFeaturePolicy;
  private disposed = false;

  constructor(
    snapshot: PreparedFeaturePolicy['snapshot'],
    private readonly entries: ReadonlyMap<FeatureId, PreparedEntry>
  ) {
    this.publicPolicy = {
      snapshot,
      prepared: new PreparedValues(entries)
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeEntries(this.entries);
  }
}

class Retirement implements FeaturePolicyRetirement {
  constructor(private readonly owned: OwnedPreparedPolicy) {}

  get policy(): PreparedFeaturePolicy {
    return this.owned.publicPolicy;
  }

  release(): void {
    this.owned.dispose();
  }
}

class PreparedValues implements ReadonlyMap<FeatureId, unknown> {
  constructor(private readonly source: ReadonlyMap<FeatureId, PreparedEntry>) {}

  get size(): number {
    return this.source.size;
  }

  get(key: FeatureId): unknown {
    return this.source.get(key)?.value;
  }

  has(key: FeatureId): boolean {
    return this.source.has(key);
  }

  forEach(
    callbackfn: (value: unknown, key: FeatureId, map: ReadonlyMap<FeatureId, unknown>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, entry] of this.source) callbackfn.call(thisArg, entry.value, key, this);
  }

  *entries(): MapIterator<[FeatureId, unknown]> {
    for (const [key, entry] of this.source) yield [key, entry.value];
  }

  keys(): MapIterator<FeatureId> {
    return this.source.keys();
  }

  *values(): MapIterator<unknown> {
    for (const entry of this.source.values()) yield entry.value;
  }

  [Symbol.iterator](): MapIterator<[FeatureId, unknown]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'PreparedFeaturePolicyValues';
  }
}

function selectedImplementations(
  implementations: readonly FeatureImplementation[],
  decisions: PreparedFeaturePolicy['snapshot']['decisions']
): ReadonlyMap<FeatureId, FeatureImplementation> {
  const selected = new Map<FeatureId, FeatureImplementation>();
  for (const [feature, decision] of decisions) {
    if (decision.implementation === null || decision.implementationVersion === null) continue;
    const implementation = implementations.find(
      (candidate) =>
        candidate.feature === feature &&
        candidate.id === decision.implementation &&
        candidate.version === decision.implementationVersion
    );
    if (implementation === undefined)
      throw new Error(
        `Selected FeaturePolicy implementation ${decision.implementation} is missing.`
      );
    selected.set(feature, implementation);
  }
  return new Map([...selected].sort(([left], [right]) => left.localeCompare(right)));
}

function snapshotCoordinatorInput(input: FeaturePolicyInput): FeaturePolicyInput {
  const registry = new FeatureImplementationRegistry();
  for (const implementation of input.implementations) registry.register(implementation);
  return {
    ...input,
    hostServices: new Set(input.hostServices),
    budget: { ...input.budget },
    requests: input.requests.map((request) => ({
      ...request,
      ...(request.supportPreference === undefined
        ? {}
        : { supportPreference: [...request.supportPreference] })
    })),
    implementations: registry.snapshot()
  };
}

function disposeEntries(entries: ReadonlyMap<FeatureId, PreparedEntry>): void {
  const errors: unknown[] = [];
  for (const { implementation, value } of [...entries.values()].reverse()) {
    try {
      implementation.dispose(value);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'FeaturePolicy resource cleanup failed.');
}

function aggregateErrors(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}

import { snapshotPredicate } from './predicates';
import type { FeatureImplementation } from './types';

export class FeatureImplementationRegistry {
  private readonly implementations = new Map<string, FeatureImplementation>();

  register<Prepared>(implementation: FeatureImplementation<Prepared>): void {
    validateImplementation(implementation);
    const key = `${implementation.feature}\u0000${implementation.id}\u0000${implementation.version}`;
    if (this.implementations.has(key))
      throw new Error(
        `Duplicate feature implementation ${implementation.feature}/${implementation.id}@${implementation.version}.`
      );
    this.implementations.set(key, snapshotImplementation(implementation));
  }

  snapshot(): readonly FeatureImplementation[] {
    return Object.freeze([...this.implementations.values()].sort(compareImplementation));
  }
}

function compareImplementation(left: FeatureImplementation, right: FeatureImplementation): number {
  return (
    left.feature.localeCompare(right.feature) ||
    left.id.localeCompare(right.id) ||
    left.version - right.version
  );
}

function validateImplementation(implementation: FeatureImplementation): void {
  if (!Number.isSafeInteger(implementation.version) || implementation.version <= 0)
    throw new Error('Feature implementation version must be a positive integer.');
  if (!Number.isFinite(implementation.priority))
    throw new Error('Feature implementation priority must be finite.');
  if (!Number.isFinite(implementation.quality.rank))
    throw new Error('Feature implementation quality rank must be finite.');
  if (implementation.semanticContract.trim() === '')
    throw new Error('Feature semantic contract must not be empty.');
}

function snapshotImplementation<Prepared>(
  value: FeatureImplementation<Prepared>
): FeatureImplementation<Prepared> {
  const common = {
    feature: value.feature,
    id: value.id,
    version: value.version,
    support: value.support,
    semanticContract: value.semanticContract,
    requirements: Object.freeze(value.requirements.map(snapshotPredicate)),
    dependencies: Object.freeze(value.dependencies.map((entry) => Object.freeze({ ...entry }))),
    conflicts: Object.freeze(
      value.conflicts.map((entry) =>
        Object.freeze({
          ...entry,
          ...(entry.implementations === undefined
            ? {}
            : { implementations: Object.freeze([...entry.implementations]) })
        })
      )
    ),
    priority: value.priority,
    quality: Object.freeze({ ...value.quality, notes: Object.freeze([...value.quality.notes]) }),
    estimate: value.estimate.bind(value),
    prepare: value.prepare.bind(value),
    dispose: value.dispose.bind(value)
  };
  return value.kind === 'runtime'
    ? (Object.freeze({
        ...common,
        kind: value.kind,
        execute: value.execute.bind(value)
      }) as FeatureImplementation<Prepared>)
    : (Object.freeze({
        ...common,
        kind: value.kind,
        contribute: value.contribute.bind(value)
      }) as FeatureImplementation<Prepared>);
}

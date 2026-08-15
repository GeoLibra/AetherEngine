import {
  addResourceBudgets,
  resourceBudgetFits,
  snapshotResourceBudget,
  validateResourceBudget,
  ZERO_RESOURCE_BUDGET
} from './budget';
import { stablePolicyHash } from './hash';
import { evaluateCapabilityPredicate } from './predicates';
import type {
  CandidateDisposition,
  DecisionReason,
  FeatureCandidateEvaluation,
  FeatureDecision,
  FeatureId,
  FeatureImplementation,
  FeaturePolicyInput,
  FeaturePolicyResolution,
  FeatureRequest,
  ImplementationId,
  ResourceBudget
} from './types';

interface Selection {
  readonly implementation: FeatureImplementation;
  readonly budget: ResourceBudget;
}
interface Failure {
  readonly reason: DecisionReason;
}

export function resolveFeaturePolicy(input: FeaturePolicyInput): FeaturePolicyResolution {
  validateInput(input);
  const requests = [...input.requests]
    .map((request) => ({
      ...request,
      ...(request.supportPreference === undefined
        ? {}
        : { supportPreference: Object.freeze([...request.supportPreference]) })
    }))
    .sort((a, b) => b.priority - a.priority || a.feature.localeCompare(b.feature));
  const declaredRequests = new Map(requests.map((request) => [request.feature, request]));
  const grouped = groupImplementations(input.implementations);
  const selected = new Map<FeatureId, Selection>();
  const evaluations = new Map<FeatureId, FeatureCandidateEvaluation[]>();
  const failures = new Map<FeatureId, DecisionReason>();
  let used: ResourceBudget = ZERO_RESOURCE_BUDGET;
  const counters = {
    candidateEvaluations: 0,
    predicateEvaluations: 0,
    estimateCalls: 0,
    dependencyVisits: 0
  };

  const resolve = (request: FeatureRequest, path: readonly FeatureId[]): Failure | undefined => {
    if (path.includes(request.feature))
      return {
        reason: reason(
          'dependency-cycle',
          `Feature dependency cycle: ${[...path, request.feature].join(' -> ')}.`
        )
      };
    const existing = selected.get(request.feature);
    if (existing !== undefined)
      return existing.implementation.semanticContract === request.semanticContract
        ? undefined
        : {
            reason: reason(
              'dependency-unsupported',
              `Selected dependency ${request.feature} has an incompatible semantic contract.`
            )
          };
    const candidates = [...(grouped.get(request.feature) ?? [])].sort((left, right) =>
      compareCandidates(left, right, request.supportPreference)
    );
    const featureEvaluations: FeatureCandidateEvaluation[] = [];
    evaluations.set(request.feature, featureEvaluations);
    let lastFailure = reason(
      'no-eligible-implementation',
      `No eligible implementation for ${request.feature}.`
    );
    const eligible: Readonly<{
      candidate: FeatureImplementation;
      capabilityResults: FeatureCandidateEvaluation['capabilityResults'];
      estimate: ResourceBudget;
      evaluationIndex: number;
    }>[] = [];
    for (const candidate of candidates) {
      counters.candidateEvaluations++;
      let capabilityResults: FeatureCandidateEvaluation['capabilityResults'] = [];
      let estimate: ResourceBudget | null = null;
      let disposition: CandidateDisposition = 'eligible';
      const reasons: DecisionReason[] = [];
      if (candidate.semanticContract !== request.semanticContract) {
        disposition = 'rejected-semantic';
        reasons.push(
          reason(
            'semantic-mismatch',
            `Expected ${request.semanticContract}, received ${candidate.semanticContract}.`
          )
        );
      } else {
        capabilityResults = candidate.requirements.map((predicate) => {
          counters.predicateEvaluations++;
          return evaluateCapabilityPredicate(predicate, input);
        });
        if (capabilityResults.some(({ satisfied }) => !satisfied)) {
          disposition = 'rejected-capability';
          reasons.push(
            reason(
              'capability-unsatisfied',
              'One or more capability predicates were not satisfied.'
            )
          );
        } else {
          counters.estimateCalls++;
          estimate = snapshotResourceBudget(candidate.estimate(input));
          if (!resourceBudgetFits(used, estimate, input.budget)) {
            disposition = 'rejected-budget';
            reasons.push(
              reason(
                'budget-exceeded',
                'Implementation estimate exceeds the remaining policy budget.'
              )
            );
          }
        }
      }
      featureEvaluations.push(
        evaluation(candidate, capabilityResults, estimate, disposition, reasons)
      );
      if (disposition !== 'eligible') {
        lastFailure = reasons[0]!;
        continue;
      }
      if (estimate === null)
        throw new Error('Eligible FeaturePolicy candidate must have an estimate.');
      eligible.push({
        candidate,
        capabilityResults,
        estimate,
        evaluationIndex: featureEvaluations.length - 1
      });
    }

    for (const { candidate, capabilityResults, estimate, evaluationIndex } of eligible) {
      const selectedBefore = new Map(selected);
      const usedBefore = used;
      let failed: Failure | undefined;
      for (const dependency of candidate.dependencies) {
        counters.dependencyVisits++;
        const declaredDependency = declaredRequests.get(dependency.feature);
        if (
          declaredDependency !== undefined &&
          declaredDependency.semanticContract !== dependency.semanticContract
        ) {
          failed = {
            reason: reason(
              'dependency-unsupported',
              `Dependency ${dependency.feature} conflicts with its declared semantic contract.`
            )
          };
          break;
        }
        failed = resolve(
          declaredDependency ?? {
            feature: dependency.feature,
            semanticContract: dependency.semanticContract,
            required: true,
            priority: request.priority
          },
          [...path, request.feature]
        );
        if (failed !== undefined) break;
      }
      if (failed === undefined) failed = conflictFailure(candidate, selected);
      if (failed === undefined && !resourceBudgetFits(used, estimate, input.budget))
        failed = {
          reason: reason('budget-exceeded', 'Dependencies consumed the remaining policy budget.')
        };
      if (failed !== undefined) {
        selected.clear();
        for (const [key, value] of selectedBefore) selected.set(key, value);
        used = usedBefore;
        const candidateReason = failed.reason;
        featureEvaluations[evaluationIndex] = evaluation(
          candidate,
          capabilityResults,
          estimate,
          candidateReason.code === 'budget-exceeded' ? 'rejected-budget' : 'rejected-conflict',
          [candidateReason]
        );
        lastFailure = candidateReason;
        continue;
      }
      used = addResourceBudgets(used, estimate);
      selected.set(request.feature, { implementation: candidate, budget: estimate });
      featureEvaluations[evaluationIndex] = evaluation(
        candidate,
        capabilityResults,
        estimate,
        'eligible',
        [reason('selected', `Selected ${candidate.id}@${candidate.version}.`)]
      );
      failures.delete(request.feature);
      return undefined;
    }
    failures.set(request.feature, lastFailure);
    return { reason: lastFailure };
  };

  for (const request of requests) resolve(request, []);
  const allFeatures = new Set<FeatureId>([
    ...requests.map(({ feature }) => feature),
    ...selected.keys(),
    ...failures.keys()
  ]);
  const decisions = new Map<FeatureId, FeatureDecision>();
  for (const feature of [...allFeatures].sort()) {
    const chosen = selected.get(feature);
    decisions.set(
      feature,
      chosen === undefined
        ? unsupportedDecision(feature, failures.get(feature))
        : selectedDecision(feature, chosen)
    );
  }
  const requestByFeature = new Map(requests.map((request) => [request.feature, request]));
  const unsupportedRequired = [...decisions]
    .filter(
      ([feature, decision]) =>
        decision.support === 'unsupported' && requestByFeature.get(feature)?.required === true
    )
    .map(([feature]) => feature)
    .sort();
  const publishedDecisions = new ReadonlyMapSnapshot(
    [...decisions].map(([key, value]) => [key, snapshotDecision(value)] as const)
  );
  const publishedEvaluations = new ReadonlyMapSnapshot(
    [...evaluations]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, Object.freeze(values.map(snapshotEvaluation))] as const)
  );
  const hash = stablePolicyHash({
    schemaVersion: input.schemaVersion,
    profileId: input.profileId,
    deviceGeneration: input.deviceGeneration,
    decisions: [...publishedDecisions],
    evaluations: [...publishedEvaluations]
  });
  const metrics = Object.freeze({
    ...counters,
    selectedFeatures: selected.size,
    unsupportedFeatures: [...decisions.values()].filter(({ support }) => support === 'unsupported')
      .length
  });
  const snapshot = Object.freeze({
    schemaVersion: input.schemaVersion,
    revision: input.revision,
    profileId: input.profileId,
    deviceGeneration: input.deviceGeneration,
    decisions: publishedDecisions,
    evaluations: publishedEvaluations,
    hash
  });
  return Object.freeze({
    ok: unsupportedRequired.length === 0,
    snapshot,
    unsupportedRequired: Object.freeze(unsupportedRequired),
    metrics
  });
}

function validateInput(input: FeaturePolicyInput): void {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0)
    throw new Error('FeaturePolicy schemaVersion must be a positive integer.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    throw new Error('FeaturePolicy revision must be a non-negative integer.');
  if (!Number.isSafeInteger(input.deviceGeneration) || input.deviceGeneration <= 0)
    throw new Error('FeaturePolicy deviceGeneration must be a positive integer.');
  if (input.profileId.trim() === '') throw new Error('FeaturePolicy profileId must not be empty.');
  validateResourceBudget(input.budget, 'FeaturePolicy budget');
  const requested = new Set<FeatureId>();
  for (const request of input.requests) {
    if (requested.has(request.feature))
      throw new Error(`Duplicate FeaturePolicy request ${request.feature}.`);
    requested.add(request.feature);
    if (request.semanticContract.trim() === '')
      throw new Error('FeaturePolicy request semantic contract must not be empty.');
    if (!Number.isFinite(request.priority))
      throw new Error('FeaturePolicy request priority must be finite.');
    if (request.supportPreference !== undefined) {
      const preference = request.supportPreference;
      if (
        preference.length !== 3 ||
        new Set(preference).size !== 3 ||
        !preference.includes('native') ||
        !preference.includes('emulated') ||
        !preference.includes('fallback')
      )
        throw new Error(
          'FeaturePolicy supportPreference must order native, emulated, and fallback exactly once.'
        );
    }
  }
}

function groupImplementations(
  values: readonly FeatureImplementation[]
): Map<FeatureId, FeatureImplementation[]> {
  const grouped = new Map<FeatureId, FeatureImplementation[]>();
  for (const value of values) {
    const bucket = grouped.get(value.feature) ?? [];
    bucket.push(value);
    grouped.set(value.feature, bucket);
  }
  return grouped;
}

const DEFAULT_SUPPORT_PREFERENCE = Object.freeze(['native', 'emulated', 'fallback'] as const);

function compareCandidates(
  a: FeatureImplementation,
  b: FeatureImplementation,
  preference: FeatureRequest['supportPreference'] = DEFAULT_SUPPORT_PREFERENCE
): number {
  return (
    preference.indexOf(a.support) - preference.indexOf(b.support) ||
    b.quality.rank - a.quality.rank ||
    b.priority - a.priority ||
    a.id.localeCompare(b.id) ||
    b.version - a.version
  );
}

function conflictFailure(
  candidate: FeatureImplementation,
  selected: ReadonlyMap<FeatureId, Selection>
): Failure | undefined {
  for (const [feature, selection] of selected) {
    if (
      conflicts(candidate, feature, selection.implementation.id) ||
      conflicts(selection.implementation, candidate.feature, candidate.id)
    )
      return {
        reason: reason(
          'conflict',
          `${candidate.feature}/${candidate.id} conflicts with ${feature}/${selection.implementation.id}.`
        )
      };
  }
  return undefined;
}
function conflicts(
  candidate: FeatureImplementation,
  feature: FeatureId,
  implementation: ImplementationId
): boolean {
  return candidate.conflicts.some(
    (entry) =>
      entry.feature === feature &&
      (entry.implementations === undefined || entry.implementations.includes(implementation))
  );
}

function evaluation(
  candidate: FeatureImplementation,
  capabilityResults: FeatureCandidateEvaluation['capabilityResults'],
  estimatedBudget: ResourceBudget | null,
  disposition: CandidateDisposition,
  reasons: readonly DecisionReason[]
): FeatureCandidateEvaluation {
  return {
    implementation: candidate.id,
    implementationVersion: candidate.version,
    semanticContract: candidate.semanticContract,
    capabilityResults,
    estimatedBudget,
    quality: candidate.quality,
    disposition,
    reasons
  };
}
function selectedDecision(feature: FeatureId, selection: Selection): FeatureDecision {
  const value = selection.implementation;
  return {
    feature,
    support: value.support,
    implementation: value.id,
    implementationVersion: value.version,
    qualityTier: value.quality.tier,
    reasons: [reason('selected', `Selected ${value.id}@${value.version}.`)],
    requirements: value.requirements,
    estimatedBudget: selection.budget
  };
}
function unsupportedDecision(feature: FeatureId, failure?: DecisionReason): FeatureDecision {
  return {
    feature,
    support: 'unsupported',
    implementation: null,
    implementationVersion: null,
    qualityTier: null,
    reasons: [
      failure ??
        reason('no-eligible-implementation', `No implementation is registered for ${feature}.`)
    ],
    requirements: [],
    estimatedBudget: ZERO_RESOURCE_BUDGET
  };
}
function reason(code: DecisionReason['code'], message: string): DecisionReason {
  return { code, message };
}

function snapshotDecision(value: FeatureDecision): FeatureDecision {
  return Object.freeze({
    ...value,
    reasons: Object.freeze(value.reasons.map((item) => Object.freeze({ ...item }))),
    requirements: Object.freeze([...value.requirements]),
    estimatedBudget: snapshotResourceBudget(value.estimatedBudget)
  });
}
function snapshotEvaluation(value: FeatureCandidateEvaluation): FeatureCandidateEvaluation {
  return Object.freeze({
    ...value,
    capabilityResults: Object.freeze(
      value.capabilityResults.map((item) => Object.freeze({ ...item }))
    ),
    estimatedBudget:
      value.estimatedBudget === null ? null : snapshotResourceBudget(value.estimatedBudget),
    quality: Object.freeze({ ...value.quality, notes: Object.freeze([...value.quality.notes]) }),
    reasons: Object.freeze(value.reasons.map((item) => Object.freeze({ ...item })))
  });
}

class ReadonlyMapSnapshot<K, V> implements ReadonlyMap<K, V> {
  private readonly data: Map<K, V>;
  constructor(entries: readonly (readonly [K, V])[]) {
    this.data = new Map(entries);
    Object.freeze(this);
  }
  get size(): number {
    return this.data.size;
  }
  get(key: K): V | undefined {
    return this.data.get(key);
  }
  has(key: K): boolean {
    return this.data.has(key);
  }
  entries(): MapIterator<[K, V]> {
    return this.data.entries();
  }
  keys(): MapIterator<K> {
    return this.data.keys();
  }
  values(): MapIterator<V> {
    return this.data.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.data[Symbol.iterator]();
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.data.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

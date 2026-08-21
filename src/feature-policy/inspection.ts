import { snapshotPredicate } from './predicates';
import type {
  CapabilityPredicate,
  DecisionReason,
  FeatureCandidateEvaluation,
  FeatureDecision,
  FeatureImplementation,
  FeaturePolicyCaptureManifest,
  FeaturePolicyInput,
  FeaturePolicyInspection,
  FeaturePolicyInspectionCandidate,
  FeaturePolicyInspectionCapabilities,
  FeaturePolicyInspectionDecision,
  FeaturePolicyInspectionEvaluation,
  FeaturePolicyInspectionImplementation,
  FeaturePolicyJsonValue,
  FeaturePolicyResolution,
  FeaturePolicySnapshot,
  FeatureRequest,
  QualityImpact,
  ResourceBudget
} from './types';

/** Creates the versioned, detached FeaturePolicy model consumed by Inspector and Cook tools. */
export function createFeaturePolicyInspection(
  input: FeaturePolicyInput,
  resolution: FeaturePolicyResolution
): FeaturePolicyInspection {
  assertMatchingEvidence(input, resolution.snapshot);
  return {
    inspectionSchemaVersion: 1,
    policy: snapshotSummary(resolution.snapshot),
    input: {
      capabilities: snapshotCapabilities(input.capabilities),
      hostServices: [...input.hostServices].sort(compareText),
      budget: copyBudget(input.budget),
      requests: input.requests.map(copyRequest).sort((a, b) => compareText(a.feature, b.feature)),
      implementations: input.implementations.map(copyImplementation).sort(compareImplementation)
    },
    decisions: snapshotDecisions(resolution.snapshot),
    evaluations: snapshotEvaluations(resolution.snapshot),
    unsupportedRequired: [...resolution.unsupportedRequired].sort(compareText),
    metrics: { ...resolution.metrics }
  };
}

/** Creates a deterministic JSON-safe manifest from one published policy snapshot. */
export function createFeaturePolicyCaptureManifest(
  snapshot: FeaturePolicySnapshot
): FeaturePolicyCaptureManifest {
  const summary = snapshotSummary(snapshot);
  return {
    manifestSchemaVersion: 1,
    policySchemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    profileId: snapshot.profileId,
    deviceGeneration: snapshot.deviceGeneration,
    policyHash: snapshot.hash,
    cacheDomainHashes: summary.cacheDomainHashes,
    decisions: snapshotDecisions(snapshot),
    evaluations: snapshotEvaluations(snapshot)
  };
}

/** Returns a detached copy of an already JSON-safe inspection publication. */
export function copyFeaturePolicyInspection(
  inspection: FeaturePolicyInspection
): FeaturePolicyInspection {
  return JSON.parse(JSON.stringify(inspection)) as FeaturePolicyInspection;
}

function assertMatchingEvidence(input: FeaturePolicyInput, snapshot: FeaturePolicySnapshot): void {
  if (
    input.schemaVersion !== snapshot.schemaVersion ||
    input.revision !== snapshot.revision ||
    input.profileId !== snapshot.profileId ||
    input.deviceGeneration !== snapshot.deviceGeneration
  ) {
    throw new Error('FeaturePolicy inspection input does not match the resolved snapshot.');
  }
}

function snapshotSummary(snapshot: FeaturePolicySnapshot): FeaturePolicyInspection['policy'] {
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    profileId: snapshot.profileId,
    deviceGeneration: snapshot.deviceGeneration,
    hash: snapshot.hash,
    cacheDomainHashes: [...snapshot.cacheDomainHashes]
      .map(([domain, hash]) => ({ domain, hash }))
      .sort((a, b) => compareText(a.domain, b.domain))
  };
}

function snapshotCapabilities(
  capabilities: FeaturePolicyInput['capabilities']
): FeaturePolicyInspectionCapabilities {
  return {
    backend: capabilities.backend,
    features: [...capabilities.features]
      .map(([feature, support]) => ({ feature, ...support }))
      .sort((a, b) => compareText(a.feature, b.feature)),
    limits: Object.keys(capabilities.limits)
      .sort(compareText)
      .map((name) => ({ name, value: capabilities.limits[name] ?? null })),
    formats: [...capabilities.formats]
      .map(([format, value]) => ({ ...value, sampleCounts: [...value.sampleCounts], format }))
      .sort((a, b) => compareText(a.format, b.format)),
    queues: capabilities.queues
      .map((queue) => ({ ...queue }))
      .sort((a, b) => compareText(a.role, b.role))
  };
}

function copyRequest(request: FeatureRequest): FeatureRequest {
  return {
    ...request,
    ...(request.supportPreference === undefined
      ? {}
      : { supportPreference: [...request.supportPreference] })
  };
}

function copyImplementation(
  implementation: FeatureImplementation
): FeaturePolicyInspectionImplementation {
  return {
    feature: implementation.feature,
    id: implementation.id,
    version: implementation.version,
    kind: implementation.kind,
    support: implementation.support,
    semanticContract: implementation.semanticContract,
    requirements: implementation.requirements.map(snapshotPredicate),
    dependencies: implementation.dependencies.map((dependency) => ({ ...dependency })),
    conflicts: implementation.conflicts.map((conflict) => ({
      ...conflict,
      ...(conflict.implementations === undefined
        ? {}
        : { implementations: [...conflict.implementations] })
    })),
    cacheDomains: [...implementation.cacheDomains].sort(compareText),
    priority: implementation.priority,
    quality: copyQuality(implementation.quality)
  };
}

function compareImplementation(
  left: FeaturePolicyInspectionImplementation,
  right: FeaturePolicyInspectionImplementation
): number {
  return (
    compareText(left.feature, right.feature) ||
    compareText(left.id, right.id) ||
    left.version - right.version
  );
}

function snapshotDecisions(snapshot: FeaturePolicySnapshot): FeaturePolicyInspectionDecision[] {
  return [...snapshot.decisions.values()]
    .map(copyDecision)
    .sort((a, b) => compareText(a.feature, b.feature));
}

function copyDecision(decision: FeatureDecision): FeaturePolicyInspectionDecision {
  return {
    ...decision,
    reasons: decision.reasons.map(copyReason),
    requirements: decision.requirements.map(snapshotPredicate),
    estimatedBudget: copyBudget(decision.estimatedBudget),
    cacheDomains: [...decision.cacheDomains].sort(compareText)
  };
}

function snapshotEvaluations(snapshot: FeaturePolicySnapshot): FeaturePolicyInspectionEvaluation[] {
  return [...snapshot.evaluations]
    .map(([feature, candidates]) => ({
      feature,
      candidates: candidates.map(copyCandidate).sort(compareCandidate)
    }))
    .sort((a, b) => compareText(a.feature, b.feature));
}

function copyCandidate(candidate: FeatureCandidateEvaluation): FeaturePolicyInspectionCandidate {
  return {
    implementation: candidate.implementation,
    implementationVersion: candidate.implementationVersion,
    semanticContract: candidate.semanticContract,
    capabilityResults: candidate.capabilityResults.map((result) => ({
      predicate: snapshotPredicate(result.predicate),
      satisfied: result.satisfied,
      actual: toJsonValue(result.actual),
      reason: result.reason
    })),
    estimatedBudget:
      candidate.estimatedBudget === null ? null : copyBudget(candidate.estimatedBudget),
    quality: copyQuality(candidate.quality),
    disposition: candidate.disposition,
    reasons: candidate.reasons.map(copyReason)
  };
}

function compareCandidate(
  left: FeaturePolicyInspectionCandidate,
  right: FeaturePolicyInspectionCandidate
): number {
  return (
    compareText(left.implementation, right.implementation) ||
    left.implementationVersion - right.implementationVersion
  );
}

function copyReason(reason: DecisionReason): DecisionReason {
  return { ...reason };
}

function copyQuality(quality: QualityImpact): QualityImpact {
  return { ...quality, notes: [...quality.notes] };
}

function copyBudget(budget: ResourceBudget): ResourceBudget {
  return { ...budget };
}

function toJsonValue(value: unknown): FeaturePolicyJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('FeaturePolicy inspection contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const copy: Record<string, FeaturePolicyJsonValue> = {};
    for (const key of Object.keys(record).sort(compareText)) copy[key] = toJsonValue(record[key]);
    return copy;
  }
  throw new Error(`FeaturePolicy inspection cannot serialize ${typeof value} evidence.`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import {
  FeatureImplementationRegistry,
  ZERO_RESOURCE_BUDGET,
  featureId,
  implementationId,
  resolveFeaturePolicy,
  type FeatureImplementation,
  type FeatureRequest
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';
import { checksum, runFeaturePolicyReference } from './reference';
import type { FeaturePolicyObservation, FeaturePolicyScenario } from './types';

export function createFeaturePolicyScenario(
  featureCount: number,
  candidateCount: number
): FeaturePolicyScenario {
  if (
    !Number.isSafeInteger(featureCount) ||
    featureCount <= 0 ||
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 2
  )
    throw new Error(
      'FeaturePolicy benchmark scales must be positive with at least two candidates.'
    );
  return {
    featureCount,
    candidateCount,
    runReference: () => runFeaturePolicyReference(featureCount, candidateCount),
    runSubject: () => runSubject(featureCount, candidateCount)
  };
}

function runSubject(featureCount: number, candidateCount: number): FeaturePolicyObservation {
  const registry = new FeatureImplementationRegistry();
  const requests: FeatureRequest[] = [];
  for (let index = 0; index < featureCount; index++) {
    const feature = featureId(`bench.feature.${index.toString().padStart(4, '0')}`);
    requests.push({ feature, semanticContract: 'bench@1', required: true, priority: 1 });
    registry.register(candidate(feature, 'native', 'bench@1', 'native', true));
    for (let candidateIndex = 0; candidateIndex < candidateCount - 2; candidateIndex++)
      registry.register(
        candidate(
          feature,
          `wrong-${candidateIndex.toString().padStart(3, '0')}`,
          'wrong@1',
          'fallback',
          false
        )
      );
    registry.register(candidate(feature, 'fallback', 'bench@1', 'fallback', false));
  }
  let resolveCount = 0;
  const runResolve = () => {
    resolveCount++;
    return resolveFeaturePolicy({
      schemaVersion: 1,
      revision: 1,
      profileId: 'benchmark',
      deviceGeneration: 1,
      capabilities: createCapabilitySnapshot({
        backend: 'null',
        features: new Map([['compute', { status: 'unsupported' }]]),
        limits: {},
        formats: new Map(),
        queues: [{ role: 'graphics', status: 'native' }]
      }),
      hostServices: new Set(),
      budget: ZERO_RESOURCE_BUDGET,
      requests,
      implementations: registry.snapshot()
    });
  };
  const result = runResolve();
  const selected = [...result.snapshot.decisions].map(
    ([feature, decision]) =>
      `${feature}:${decision.implementation}@${decision.implementationVersion}`
  );
  const evaluations = [...result.snapshot.evaluations].flatMap(([feature, values]) =>
    values.map(
      (value) =>
        `${feature}:${value.implementation}@${value.implementationVersion}:${value.disposition}`
    )
  );
  const resolveCountBeforeReads = resolveCount;
  for (let iteration = 0; iteration < 100; iteration++)
    for (const request of requests) {
      if (result.snapshot.decisions.get(request.feature) === undefined)
        throw new Error('Missing benchmark decision.');
    }
  const hotReadResolveCount = resolveCount - resolveCountBeforeReads;
  return {
    checksum: checksum([...selected, '--evaluations--', ...evaluations]),
    selected,
    evaluations,
    counters: {
      ...result.metrics,
      selectedFeatures: result.metrics.selectedFeatures,
      cacheDomainHashes: result.snapshot.cacheDomainHashes.size,
      hotReadResolveCount
    }
  };
}

function candidate(
  feature: ReturnType<typeof featureId>,
  id: string,
  semanticContract: string,
  support: 'native' | 'fallback',
  needsCompute: boolean
): FeatureImplementation<undefined> {
  return {
    kind: 'runtime',
    feature,
    id: implementationId(id),
    version: 1,
    support,
    semanticContract,
    requirements: needsCompute
      ? [{ kind: 'feature', feature: 'compute', statuses: ['native'] }]
      : [],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['shader-pipeline'],
    priority: 0,
    quality: { tier: id, rank: 0, notes: [] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => undefined,
    dispose: () => undefined,
    execute: () => undefined
  };
}

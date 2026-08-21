import { describe, expect, test } from 'vitest';
import {
  ZERO_RESOURCE_BUDGET,
  createFeaturePolicyCaptureManifest,
  createFeaturePolicyInspection,
  featureId,
  implementationId,
  resolveFeaturePolicy,
  type FeatureImplementation,
  type FeaturePolicyInput
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const feature = featureId('test.inspection');

describe('FeaturePolicy inspection and capture', () => {
  test('publishes complete, sorted, JSON-safe input and decision evidence', () => {
    const source = input([
      candidate('z-candidate'),
      candidate('a-missing-limit', {
        requirements: [{ kind: 'limit', limit: 'missingLimit', minimum: 4 }]
      })
    ]);
    const resolution = resolveFeaturePolicy(source);

    const inspection = createFeaturePolicyInspection(source, resolution);
    const roundTrip = JSON.parse(JSON.stringify(inspection));

    expect(roundTrip).toEqual(inspection);
    expect(inspection.inspectionSchemaVersion).toBe(1);
    expect(inspection.policy.hash).toBe(resolution.snapshot.hash);
    expect(inspection.input.capabilities.features.map(({ feature }) => feature)).toEqual([
      'compute',
      'storage-buffer'
    ]);
    expect(inspection.input.capabilities.limits.map(({ name }) => name)).toEqual([
      'maxBindings',
      'missingLimit'
    ]);
    expect(inspection.input.implementations.map(({ id }) => id)).toEqual([
      'a-missing-limit',
      'z-candidate'
    ]);
    expect(inspection.decisions[0]?.feature).toBe(feature);
    expect(
      inspection.evaluations[0]?.candidates.map(({ implementation }) => implementation)
    ).toEqual(['a-missing-limit', 'z-candidate']);
    expect(inspection.evaluations[0]?.candidates[0]?.capabilityResults[0]?.actual).toBeNull();
  });

  test('creates a deterministic capture manifest from the published snapshot only', () => {
    const firstInput = input([candidate('z-candidate'), candidate('a-candidate')]);
    const secondInput = input([candidate('a-candidate'), candidate('z-candidate')]);
    const first = resolveFeaturePolicy(firstInput).snapshot;
    const second = resolveFeaturePolicy(secondInput).snapshot;

    const firstManifest = createFeaturePolicyCaptureManifest(first);
    const secondManifest = createFeaturePolicyCaptureManifest(second);

    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest.manifestSchemaVersion).toBe(1);
    expect(firstManifest.policyHash).toBe(first.hash);
    expect(firstManifest.decisions[0]?.feature).toBe(feature);
    expect(JSON.parse(JSON.stringify(firstManifest))).toEqual(firstManifest);
    expect('prepared' in firstManifest).toBe(false);
  });

  test('returns detached tool models and rejects mismatched input evidence', () => {
    const source = input([candidate('candidate')]);
    const resolution = resolveFeaturePolicy(source);
    const first = createFeaturePolicyInspection(source, resolution);
    (first.input.budget as { cpuTimeMs: number }).cpuTimeMs = 99;

    const second = createFeaturePolicyInspection(source, resolution);
    expect(second.input.budget.cpuTimeMs).toBe(0);

    expect(() =>
      createFeaturePolicyInspection({ ...source, profileId: 'other' }, resolution)
    ).toThrow('does not match the resolved snapshot');
  });
});

function candidate(
  id: string,
  overrides: Partial<FeatureImplementation<string>> = {}
): FeatureImplementation<string> {
  return {
    kind: 'runtime',
    feature,
    id: implementationId(id),
    version: 1,
    support: 'fallback',
    semanticContract: 'test.inspection@1',
    requirements: [],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['history'],
    priority: 1,
    quality: { tier: 'test', rank: 1, notes: ['deterministic'] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => id,
    dispose: () => undefined,
    execute: () => undefined,
    ...overrides
  } as FeatureImplementation<string>;
}

function input(implementations: readonly FeatureImplementation[]): FeaturePolicyInput {
  return {
    schemaVersion: 1,
    revision: 4,
    profileId: 'inspection-test',
    deviceGeneration: 2,
    capabilities: createCapabilitySnapshot({
      backend: 'webgpu',
      features: new Map([
        ['storage-buffer', { status: 'native' }],
        ['compute', { status: 'native' }]
      ]),
      limits: { missingLimit: undefined, maxBindings: 8 },
      formats: new Map(),
      queues: [{ role: 'graphics', status: 'native' }]
    }),
    hostServices: new Set(),
    budget: ZERO_RESOURCE_BUDGET,
    requests: [
      {
        feature,
        semanticContract: 'test.inspection@1',
        required: true,
        priority: 1
      }
    ],
    implementations
  };
}

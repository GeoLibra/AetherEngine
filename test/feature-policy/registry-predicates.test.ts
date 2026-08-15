import { describe, expect, test } from 'vitest';
import {
  FeatureImplementationRegistry,
  ZERO_RESOURCE_BUDGET,
  evaluateCapabilityPredicate,
  featureId,
  hostServiceId,
  implementationId,
  type FeatureImplementation
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const feature = featureId('test.feature');

describe('FeaturePolicy identities and registry', () => {
  test('normalizes public IDs and rejects empty ownership identities', () => {
    expect(featureId('  test.feature  ')).toBe('test.feature');
    expect(implementationId(' cpu@1 ')).toBe('cpu@1');
    expect(hostServiceId(' main-cpu ')).toBe('main-cpu');
    expect(() => featureId(' ')).toThrow('Feature ID must not be empty');
  });

  test('publishes implementations in canonical order and rejects duplicate identity', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(implementation('z', 2));
    registry.register(implementation('a', 1));

    const snapshot = registry.snapshot();
    expect(snapshot.map(({ id, version }) => `${id}@${version}`)).toEqual(['a@1', 'z@2']);
    expect(Object.isFrozen(snapshot)).toBe(false);
    (snapshot as FeatureImplementation[]).length = 0;
    expect(registry.snapshot()).toHaveLength(2);
    expect(() => registry.register(implementation('a', 1))).toThrow(
      'Duplicate feature implementation'
    );
  });

  test('captures implementations through their interface rather than enumerable object shape', () => {
    const registry = new FeatureImplementationRegistry();
    const inherited = Object.create(
      implementation('inherited', 1)
    ) as FeatureImplementation<undefined>;
    registry.register(inherited);
    const published = registry.snapshot()[0];
    expect(published?.id).toBe('inherited');
    expect(published?.estimate({} as never)).toEqual(ZERO_RESOURCE_BUDGET);
  });
});

describe('FeaturePolicy capability predicates', () => {
  const capabilities = createCapabilitySnapshot({
    backend: 'webgl2',
    features: new Map([['compute', { status: 'unsupported', reason: 'no compute' }]]),
    limits: { maxStorageBuffers: 8 },
    formats: new Map([
      [
        'rgba16float',
        {
          sample: true,
          filter: false,
          render: true,
          blend: false,
          storage: false,
          copySrc: true,
          copyDst: true,
          sampleCounts: [1]
        }
      ]
    ]),
    queues: [{ role: 'graphics', status: 'native' }]
  });
  const input = { capabilities, hostServices: new Set([hostServiceId('main-cpu')]) };

  test('returns structured results for feature, limit, format, queue, and service facts', () => {
    expect(
      evaluateCapabilityPredicate(
        { kind: 'feature', feature: 'compute', statuses: ['native'] },
        input
      ).satisfied
    ).toBe(false);
    expect(
      evaluateCapabilityPredicate({ kind: 'limit', limit: 'maxStorageBuffers', minimum: 8 }, input)
        .satisfied
    ).toBe(true);
    expect(
      evaluateCapabilityPredicate(
        { kind: 'format', format: 'rgba16float', capability: 'render' },
        input
      ).satisfied
    ).toBe(true);
    expect(
      evaluateCapabilityPredicate({ kind: 'queue', role: 'graphics', statuses: ['native'] }, input)
        .satisfied
    ).toBe(true);
    expect(
      evaluateCapabilityPredicate({ kind: 'service', service: hostServiceId('main-cpu') }, input)
        .satisfied
    ).toBe(true);
    const missing = evaluateCapabilityPredicate(
      { kind: 'format', format: 'rgba16float', capability: 'filter' },
      input
    );
    expect(missing).toMatchObject({ satisfied: false, actual: false });
  });
});

function implementation(id: string, version: number): FeatureImplementation<undefined> {
  return {
    kind: 'runtime',
    feature,
    id: implementationId(id),
    version,
    support: 'fallback',
    semanticContract: 'test@1',
    requirements: [],
    dependencies: [],
    conflicts: [],
    priority: 0,
    quality: { tier: 'test', rank: 0, notes: [] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => undefined,
    dispose: () => undefined,
    execute: () => undefined
  };
}

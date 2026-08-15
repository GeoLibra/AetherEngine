import { describe, expect, test } from 'vitest';
import {
  FeatureImplementationRegistry,
  ZERO_RESOURCE_BUDGET,
  featureId,
  hostServiceId,
  implementationId,
  resolveFeaturePolicy,
  type FeatureImplementation,
  type FeaturePolicyInput,
  type ResourceBudget
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const target = featureId('test.target');
const dependency = featureId('test.dependency');

describe('resolveFeaturePolicy', () => {
  test('selects by semantics, capability, support preference, quality, and stable identity', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(candidate({ id: 'fallback', support: 'fallback' }));
    registry.register(candidate({ id: 'native-z', support: 'native', qualityRank: 2 }));
    registry.register(candidate({ id: 'native-a', support: 'native', qualityRank: 2 }));
    registry.register(candidate({ id: 'wrong-semantic', semantic: 'other@1' }));
    registry.register(
      candidate({
        id: 'needs-compute',
        requirements: [{ kind: 'feature', feature: 'compute', statuses: ['native'] }]
      })
    );

    const result = resolveFeaturePolicy(input(registry));

    expect(result.ok).toBe(true);
    expect(result.snapshot.decisions.get(target)).toMatchObject({
      support: 'native',
      implementation: 'native-a'
    });
    expect(
      result.snapshot.evaluations.get(target)?.map(({ disposition }) => disposition)
    ).toContain('rejected-semantic');
    expect(result.metrics.predicateEvaluations).toBe(1);
  });

  test('selects an approved fallback when higher support exceeds the shared budget', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(
      candidate({ id: 'native', support: 'native', budget: budget({ gpuMemoryBytes: 101 }) })
    );
    registry.register(
      candidate({ id: 'cpu', support: 'fallback', budget: budget({ cpuMemoryBytes: 10 }) })
    );
    const result = resolveFeaturePolicy(
      input(registry, { budget: budget({ cpuMemoryBytes: 20, gpuMemoryBytes: 100 }) })
    );
    expect(result.snapshot.decisions.get(target)).toMatchObject({
      support: 'fallback',
      implementation: 'cpu'
    });
    expect(
      result.snapshot.evaluations
        .get(target)
        ?.find(({ implementation }) => implementation === implementationId('native'))?.disposition
    ).toBe('rejected-budget');
  });

  test('honors explicit product support preference instead of unconditionally preferring native', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(candidate({ id: 'native', support: 'native' }));
    registry.register(candidate({ id: 'emulated', support: 'emulated' }));
    const result = resolveFeaturePolicy(
      input(registry, {
        requests: [
          {
            feature: target,
            semanticContract: 'target@1',
            required: true,
            priority: 1,
            supportPreference: ['emulated', 'native', 'fallback']
          }
        ]
      })
    );
    expect(result.snapshot.decisions.get(target)?.implementation).toBe('emulated');
  });

  test('keeps optional unsupported observable and fails required unsupported with evidence', () => {
    const registry = new FeatureImplementationRegistry();
    const optional = resolveFeaturePolicy(input(registry, { required: false }));
    expect(optional.ok).toBe(true);
    expect(optional.snapshot.decisions.get(target)?.support).toBe('unsupported');

    const required = resolveFeaturePolicy(input(registry, { required: true }));
    expect(required.ok).toBe(false);
    expect(required.unsupportedRequired).toEqual([target]);
    expect(required.snapshot.decisions.get(target)?.reasons[0]?.code).toBe(
      'no-eligible-implementation'
    );
  });

  test('resolves dependencies transactionally and reports cycles and conflicts', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(
      candidate({
        id: 'target',
        dependencies: [{ feature: dependency, semanticContract: 'dependency@1' }]
      })
    );
    registry.register(
      candidate({ feature: dependency, id: 'dependency', semantic: 'dependency@1' })
    );
    let result = resolveFeaturePolicy(input(registry));
    expect(result.snapshot.decisions.get(dependency)?.implementation).toBe('dependency');

    const cyclic = new FeatureImplementationRegistry();
    cyclic.register(
      candidate({
        id: 'target',
        dependencies: [{ feature: dependency, semanticContract: 'dependency@1' }]
      })
    );
    cyclic.register(
      candidate({
        feature: dependency,
        id: 'dependency',
        semantic: 'dependency@1',
        dependencies: [{ feature: target, semanticContract: 'target@1' }]
      })
    );
    result = resolveFeaturePolicy(input(cyclic));
    expect(result.ok).toBe(false);
    expect(
      result.snapshot.decisions.get(target)?.reasons.some(({ code }) => code === 'dependency-cycle')
    ).toBe(true);

    const conflict = new FeatureImplementationRegistry();
    conflict.register(candidate({ id: 'target', conflicts: [{ feature: dependency }] }));
    conflict.register(
      candidate({ feature: dependency, id: 'dependency', semantic: 'dependency@1' })
    );
    result = resolveFeaturePolicy(
      input(conflict, {
        requests: [
          { feature: target, semanticContract: 'target@1', required: true, priority: 2 },
          { feature: dependency, semanticContract: 'dependency@1', required: true, priority: 1 }
        ]
      })
    );
    expect(result.snapshot.decisions.get(dependency)?.support).toBe('unsupported');
  });

  test('copies caller inputs and hashes canonical decisions independently of registration order', () => {
    const first = new FeatureImplementationRegistry();
    const second = new FeatureImplementationRegistry();
    first.register(candidate({ id: 'z' }));
    first.register(candidate({ id: 'a' }));
    second.register(candidate({ id: 'a' }));
    second.register(candidate({ id: 'z' }));
    const firstResult = resolveFeaturePolicy(input(first));
    const secondResult = resolveFeaturePolicy(input(second));
    expect(firstResult.snapshot.hash).toBe(secondResult.snapshot.hash);
    expect(Object.isFrozen(firstResult.snapshot)).toBe(true);
    expect(Object.isFrozen(firstResult.snapshot.decisions.get(target)?.reasons)).toBe(true);
  });

  test('rejects duplicate feature requests instead of silently accepting conflicting semantics', () => {
    const registry = new FeatureImplementationRegistry();
    registry.register(candidate({ id: 'target' }));
    expect(() =>
      resolveFeaturePolicy(
        input(registry, {
          requests: [
            { feature: target, semanticContract: 'target@1', required: true, priority: 1 },
            { feature: target, semanticContract: 'other@1', required: true, priority: 1 }
          ]
        })
      )
    ).toThrow('Duplicate FeaturePolicy request');
  });
});

function input(
  registry: FeatureImplementationRegistry,
  overrides: Partial<FeaturePolicyInput> & { required?: boolean } = {}
): FeaturePolicyInput {
  return {
    schemaVersion: 1,
    revision: 1,
    profileId: 'test',
    deviceGeneration: 7,
    capabilities: createCapabilitySnapshot({
      backend: 'webgpu',
      features: new Map([['compute', { status: 'unsupported' }]]),
      limits: {},
      formats: new Map(),
      queues: [{ role: 'graphics', status: 'native' }]
    }),
    hostServices: new Set([hostServiceId('main-cpu')]),
    budget: overrides.budget ?? budget({ cpuMemoryBytes: 1_000, gpuMemoryBytes: 1_000 }),
    requests: overrides.requests ?? [
      {
        feature: target,
        semanticContract: 'target@1',
        required: overrides.required ?? true,
        priority: 1
      }
    ],
    implementations: registry.snapshot()
  };
}

function candidate(options: {
  feature?: typeof target;
  id: string;
  version?: number;
  support?: 'native' | 'emulated' | 'fallback';
  semantic?: string;
  qualityRank?: number;
  requirements?: FeatureImplementation<undefined>['requirements'];
  dependencies?: FeatureImplementation<undefined>['dependencies'];
  conflicts?: FeatureImplementation<undefined>['conflicts'];
  budget?: ResourceBudget;
}): FeatureImplementation<undefined> {
  return {
    kind: 'runtime',
    feature: options.feature ?? target,
    id: implementationId(options.id),
    version: options.version ?? 1,
    support: options.support ?? 'native',
    semanticContract:
      options.semantic ?? (options.feature === dependency ? 'dependency@1' : 'target@1'),
    requirements: options.requirements ?? [],
    dependencies: options.dependencies ?? [],
    conflicts: options.conflicts ?? [],
    priority: 0,
    quality: { tier: 'test', rank: options.qualityRank ?? 1, notes: [] },
    estimate: () => options.budget ?? ZERO_RESOURCE_BUDGET,
    prepare: async () => undefined,
    dispose: () => undefined,
    execute: () => undefined
  };
}

function budget(overrides: Partial<ResourceBudget> = {}): ResourceBudget {
  return {
    cpuTimeMs: 0,
    gpuTimeMs: 0,
    cpuMemoryBytes: 0,
    gpuMemoryBytes: 0,
    uploadBytesPerFrame: 0,
    readbackBytesPerFrame: 0,
    compileTimeMs: 0,
    ...overrides
  };
}

import { describe, expect, test } from 'vitest';
import {
  FeaturePolicyCoordinator,
  ZERO_RESOURCE_BUDGET,
  featureId,
  implementationId,
  type FeatureImplementation,
  type FeatureId,
  type FeaturePolicyInput
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const target = featureId('test.coordinator');
const secondary = featureId('test.coordinator.secondary');

describe('FeaturePolicyCoordinator', () => {
  test('keeps a prepared policy hidden until the frame boundary publishes it', async () => {
    const prepared = { label: 'prepared' };
    const coordinator = new FeaturePolicyCoordinator();

    const stage = await coordinator.prepare(input(candidate(prepared)));

    expect(stage.ok).toBe(true);
    expect(coordinator.current).toBeUndefined();

    const publication = coordinator.publish();

    expect(publication?.current.snapshot.revision).toBe(1);
    expect(publication?.current.prepared.get(target)).toBe(prepared);
    expect(coordinator.current).toBe(publication?.current);
  });

  test('rolls back a failed preparation and preserves the last-good policy', async () => {
    const disposed: string[] = [];
    const coordinator = new FeaturePolicyCoordinator();
    await coordinator.prepare(input(candidate({ label: 'last-good' })));
    coordinator.publish();

    const replacement = candidate(
      { label: 'replacement' },
      { dispose: () => disposed.push('replacement') }
    );
    const result = await coordinator.prepare(
      input(replacement, {
        revision: 2,
        requests: [
          request(target, 'test.coordinator@1'),
          request(secondary, 'test.coordinator.secondary@1')
        ],
        implementations: [
          replacement,
          candidate(
            { label: 'never' },
            {
              feature: secondary,
              id: 'failing',
              semanticContract: 'test.coordinator.secondary@1',
              prepare: async () => {
                throw new Error('prepare failed');
              }
            }
          )
        ]
      })
    );

    expect(result.ok).toBe(false);
    expect(disposed).toEqual(['replacement']);
    expect(coordinator.current?.snapshot.revision).toBe(1);
    expect(coordinator.publish()).toBeUndefined();
  });

  test('releases owned policies exactly once across retirement and shutdown', async () => {
    const disposed: string[] = [];
    const coordinator = new FeaturePolicyCoordinator();
    await coordinator.prepare(
      input(candidate({ label: 'first' }, { dispose: () => disposed.push('first') }))
    );
    coordinator.publish();
    await coordinator.prepare(
      input(candidate({ label: 'second' }, { dispose: () => disposed.push('second') }), {
        revision: 2
      })
    );

    const retirement = coordinator.publish()?.retirement;
    retirement?.release();
    retirement?.release();
    coordinator.destroy();
    coordinator.destroy();

    expect(disposed).toEqual(['first', 'second']);
    expect(coordinator.current).toBeUndefined();
  });

  test('rejects concurrent preparation before either revision can allocate twice', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const coordinator = new FeaturePolicyCoordinator();
    const first = coordinator.prepare(
      input(
        candidate(
          { label: 'first' },
          {
            prepare: async () => {
              await gate;
              return { label: 'first' };
            }
          }
        )
      )
    );

    await expect(
      coordinator.prepare(input(candidate({ label: 'second' }), { revision: 2 }))
    ).rejects.toThrow('already in progress');

    resume();
    await first;
    coordinator.destroy();
  });

  test('disposes preparation that completes after coordinator shutdown', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const disposed: string[] = [];
    const coordinator = new FeaturePolicyCoordinator();
    const preparation = coordinator.prepare(
      input(
        candidate(
          { label: 'late' },
          {
            prepare: async () => {
              await gate;
              return { label: 'late' };
            },
            dispose: () => disposed.push('late')
          }
        )
      )
    );

    coordinator.destroy();
    resume();
    const result = await preparation;

    expect(result.ok).toBe(false);
    expect(disposed).toEqual(['late']);
    expect(coordinator.current).toBeUndefined();
  });

  test('rejects a revision that is not newer than the published policy', async () => {
    const coordinator = new FeaturePolicyCoordinator();
    await coordinator.prepare(input(candidate({ label: 'current' }), { revision: 2 }));
    coordinator.publish();

    await expect(
      coordinator.prepare(input(candidate({ label: 'stale' }), { revision: 1 }))
    ).rejects.toThrow('newer than the published revision');
    await expect(
      coordinator.prepare(input(candidate({ label: 'duplicate' }), { revision: 2 }))
    ).rejects.toThrow('newer than the published revision');

    coordinator.destroy();
  });

  test('continues retirement cleanup when one implementation dispose fails', async () => {
    const disposed: string[] = [];
    const coordinator = new FeaturePolicyCoordinator();
    await coordinator.prepare(
      input(candidate({ label: 'first' }), {
        requests: [
          request(target, 'test.coordinator@1'),
          request(secondary, 'test.coordinator.secondary@1')
        ],
        implementations: [
          candidate(
            { label: 'first' },
            {
              dispose: () => {
                disposed.push('first');
                throw new Error('first dispose failed');
              }
            }
          ),
          candidate(
            { label: 'second' },
            {
              feature: secondary,
              id: 'second',
              semanticContract: 'test.coordinator.secondary@1',
              dispose: () => disposed.push('second')
            }
          )
        ]
      })
    );
    coordinator.publish();

    expect(() => coordinator.destroy()).toThrow(AggregateError);
    expect(disposed).toEqual(['second', 'first']);
    expect(coordinator.current).toBeUndefined();
  });

  test('does not retain caller-owned implementation methods after preparation begins', async () => {
    const disposed: string[] = [];
    const implementation = candidate(
      { label: 'owned' },
      { dispose: () => disposed.push('original') }
    );
    const coordinator = new FeaturePolicyCoordinator();

    await coordinator.prepare(input(implementation));
    Object.assign(implementation, { dispose: () => disposed.push('mutated') });
    coordinator.publish();
    coordinator.destroy();

    expect(disposed).toEqual(['original']);
  });

  test('publishes precise cache invalidations only after the policy swap', async () => {
    const coordinator = new FeaturePolicyCoordinator();
    await coordinator.prepare(
      input(candidate({ label: 'first' }, { cacheDomains: ['shader-pipeline'] }))
    );
    expect(coordinator.publish()?.invalidations).toEqual([]);

    await coordinator.prepare(
      input(candidate({ label: 'second' }, { id: 'second', cacheDomains: ['history'] }), {
        revision: 2
      })
    );
    const publication = coordinator.publish();

    expect(publication?.invalidations.map(({ domain }) => domain)).toEqual([
      'history',
      'shader-pipeline'
    ]);
    publication?.retirement?.release();
    coordinator.destroy();
  });
});

function candidate(
  prepared: object,
  overrides: Partial<Omit<FeatureImplementation<object>, 'kind' | 'id' | 'feature'>> & {
    feature?: FeatureId;
    id?: string;
    semanticContract?: string;
  } = {}
): FeatureImplementation<object> {
  return {
    kind: 'runtime',
    version: 1,
    support: 'native',
    semanticContract: overrides.semanticContract ?? 'test.coordinator@1',
    requirements: [],
    dependencies: [],
    conflicts: [],
    cacheDomains: [],
    priority: 1,
    quality: { tier: 'default', rank: 1, notes: [] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => prepared,
    dispose: () => undefined,
    execute: () => undefined,
    ...overrides,
    feature: overrides.feature ?? target,
    id: implementationId(overrides.id ?? 'test.runtime')
  };
}

function input(
  implementation: FeatureImplementation,
  overrides: Partial<FeaturePolicyInput> = {}
): FeaturePolicyInput {
  return {
    schemaVersion: 1,
    revision: overrides.revision ?? 1,
    profileId: 'test',
    deviceGeneration: 1,
    capabilities: createCapabilitySnapshot({
      backend: 'webgpu',
      features: new Map(),
      limits: {},
      formats: new Map(),
      queues: [{ role: 'graphics', status: 'native' }]
    }),
    hostServices: new Set(),
    budget: ZERO_RESOURCE_BUDGET,
    requests: overrides.requests ?? [request(target, 'test.coordinator@1')],
    implementations: overrides.implementations ?? [implementation]
  };
}

function request(feature: FeatureId, semanticContract: string) {
  return { feature, semanticContract, required: true, priority: 1 } as const;
}

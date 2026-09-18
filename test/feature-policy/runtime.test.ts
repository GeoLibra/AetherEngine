import { describe, expect, test } from 'vitest';
import {
  FeaturePolicyRuntimeController,
  ZERO_RESOURCE_BUDGET,
  featureId,
  implementationId,
  type FeatureImplementation,
  type FeaturePolicyRuntimeInput
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const feature = featureId('test.runtime-controller');

describe('FeaturePolicyRuntimeController', () => {
  test('stages one changed revision and keeps it hidden until frame-boundary publish', async () => {
    const runtime = new FeaturePolicyRuntimeController();

    const staged = await runtime.stage(input(candidate('first')));

    expect(staged.status).toBe('prepared');
    expect(runtime.current).toBeUndefined();
    expect(runtime.state).toBe('awaiting-publish');

    const publication = runtime.publishFrameBoundary();

    expect(publication?.current.snapshot.revision).toBe(1);
    expect(runtime.current).toBe(publication?.current);
    expect(runtime.state).toBe('idle');
  });

  test('does not consume new events while a prepared revision awaits publication', async () => {
    const runtime = new FeaturePolicyRuntimeController();
    await runtime.stage(input(candidate('first')));
    runtime.sources.profileChanged();

    expect((await runtime.stage(input(candidate('second')))).status).toBe('awaiting-publish');
    runtime.publishFrameBoundary();

    const second = await runtime.stage(input(candidate('second')));
    expect(second.status).toBe('prepared');
    if (second.status !== 'prepared') throw new Error('Expected a prepared revision.');
    expect(second.result.policy.snapshot.revision).toBe(2);
  });

  test('does not consume new events while asynchronous preparation is in progress', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const runtime = new FeaturePolicyRuntimeController();
    const first = runtime.stage(
      input(
        candidate('first', {
          prepare: async () => {
            await gate;
            return 'first';
          }
        })
      )
    );
    runtime.sources.budgetChanged();

    expect((await runtime.stage(input(candidate('second')))).status).toBe('preparing');

    resume();
    await first;
    runtime.publishFrameBoundary();
    const second = await runtime.stage(input(candidate('second')));
    expect(second.status).toBe('prepared');
  });

  test('preserves last-good after failure and stages again only for a newer source', async () => {
    const runtime = new FeaturePolicyRuntimeController();
    await runtime.stage(input(candidate('last-good')));
    runtime.publishFrameBoundary();
    runtime.sources.registryChanged();

    const failed = await runtime.stage(
      input(
        candidate('failed', {
          prepare: async () => {
            throw new Error('compile failed');
          }
        })
      )
    );

    expect(failed.status).toBe('failed');
    expect(runtime.current?.prepared.get(feature)).toBe('last-good');
    expect((await runtime.stage(input(candidate('same-source')))).status).toBe('unchanged');

    runtime.sources.registryChanged();
    expect((await runtime.stage(input(candidate('recovered')))).status).toBe('prepared');
  });

  test('publishes the latest attempted decision tree without replacing last-good on failure', async () => {
    const runtime = new FeaturePolicyRuntimeController();
    await runtime.stage(input(candidate('last-good')));
    runtime.publishFrameBoundary();
    runtime.sources.profileChanged();

    await runtime.stage(
      input(
        candidate('failed', {
          prepare: async () => {
            throw new Error('prepare failed');
          }
        })
      )
    );

    expect(runtime.current?.snapshot.revision).toBe(1);
    expect(runtime.inspection?.policy.revision).toBe(2);
    expect(runtime.inspection?.decisions[0]?.implementation).toBe(
      implementationId('test.runtime-controller.cpu')
    );
    expect(JSON.parse(JSON.stringify(runtime.inspection))).toEqual(runtime.inspection);

    const published = runtime.inspection;
    if (published === undefined) throw new Error('Expected inspection evidence.');
    (published.policy as { revision: number }).revision = 99;
    expect(runtime.inspection?.policy.revision).toBe(2);
  });

  test('releases active publication root retirement when destroyed directly after publish', async () => {
    const disposed: string[] = [];
    const runtime = new FeaturePolicyRuntimeController();
    await runtime.stage(
      input(candidate('first', { dispose: () => disposed.push('first') }))
    );
    runtime.publishFrameBoundary();

    runtime.sources.profileChanged();
    await runtime.stage(
      input(candidate('second', { dispose: () => disposed.push('second') }))
    );
    const pub = runtime.publishFrameBoundary();
    expect(pub?.retirement).toBeDefined();

    // Destroying runtime directly without calling releaseActivePublication explicitly
    runtime.destroy();

    // Both first (which was retired) and second (which was active) are disposed
    expect(disposed).toEqual(['first', 'second']);
  });

  test('releases previous publication root retirement on subsequent publishFrameBoundary even without PostRender', async () => {
    const disposed: string[] = [];
    const runtime = new FeaturePolicyRuntimeController();
    await runtime.stage(
      input(candidate('first', { dispose: () => disposed.push('first') }))
    );
    runtime.publishFrameBoundary();

    runtime.sources.profileChanged();
    await runtime.stage(
      input(candidate('second', { dispose: () => disposed.push('second') }))
    );
    const pub = runtime.publishFrameBoundary();
    expect(pub?.retirement).toBeDefined();

    // Simulate skipped PostRender: releaseActivePublication is NOT called
    expect(disposed).toEqual([]);

    // Next frame boundary with no pending publish: cleans up active publication root
    runtime.publishFrameBoundary();
    expect(disposed).toEqual(['first']);

    runtime.destroy();
  });
});

function candidate(
  prepared: string,
  overrides: Partial<FeatureImplementation<string>> = {}
): FeatureImplementation<string> {
  return {
    kind: 'runtime',
    feature,
    id: implementationId('test.runtime-controller.cpu'),
    version: 1,
    support: 'fallback',
    semanticContract: 'test.runtime-controller@1',
    requirements: [],
    dependencies: [],
    conflicts: [],
    cacheDomains: [],
    priority: 1,
    quality: { tier: 'test', rank: 1, notes: [] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => prepared,
    dispose: () => undefined,
    execute: () => undefined,
    ...overrides
  } as FeatureImplementation<string>;
}

function input(implementation: FeatureImplementation): FeaturePolicyRuntimeInput {
  return {
    schemaVersion: 1,
    profileId: 'test',
    deviceGeneration: 1,
    capabilities: createCapabilitySnapshot({
      backend: 'null',
      features: new Map(),
      limits: {},
      formats: new Map(),
      queues: [{ role: 'graphics', status: 'native' }]
    }),
    hostServices: new Set(),
    budget: ZERO_RESOURCE_BUDGET,
    requests: [
      {
        feature,
        semanticContract: 'test.runtime-controller@1',
        required: true,
        priority: 1
      }
    ],
    implementations: [implementation]
  };
}

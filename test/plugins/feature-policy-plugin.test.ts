import { describe, expect, test } from 'vitest';
import {
  App,
  FeaturePolicyRuntimeResource,
  HeadlessRunner,
  ZERO_RESOURCE_BUDGET,
  createFeaturePolicyPlugin,
  featureId,
  implementationId,
  type FeatureImplementation,
  type FeaturePolicyPublication,
  type FeaturePolicyRuntimeInput
} from '../../src';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const feature = featureId('test.feature-policy-plugin');

describe('FeaturePolicyPlugin', () => {
  test('stages during startup, publishes in PreRender, and destroys owned policy', async () => {
    const publications: FeaturePolicyPublication[] = [];
    const disposed: string[] = [];
    const app = new App().addPlugin(
      createFeaturePolicyPlugin({
        input: () => input(candidate('prepared', disposed)),
        onPublication: (publication) => publications.push(publication)
      })
    );

    await app.startup();
    const runtime = app.getResource(FeaturePolicyRuntimeResource);
    expect(runtime?.state).toBe('awaiting-publish');
    expect(runtime?.current).toBeUndefined();

    await app.run(new HeadlessRunner({ frames: 1 }));

    expect(runtime?.current?.prepared.get(feature)).toBe('prepared');
    expect(publications).toHaveLength(1);
    expect(publications[0]?.current.snapshot.revision).toBe(1);

    await app.destroy();
    expect(runtime?.state).toBe('destroyed');
    expect(disposed).toEqual(['prepared']);
  });

  test('fails startup when the initial required policy cannot prepare', async () => {
    const app = new App().addPlugin(
      createFeaturePolicyPlugin({
        input: () =>
          input(
            candidate('unused', [], {
              prepare: async () => {
                throw new Error('initial prepare failed');
              }
            })
          )
      })
    );

    await expect(app.startup()).rejects.toThrow('initial prepare failed');
    expect(app.state).toBe('failed');
  });
});

function candidate(
  prepared: string,
  disposed: string[] = [],
  overrides: Partial<FeatureImplementation<string>> = {}
): FeatureImplementation<string> {
  return {
    kind: 'runtime',
    feature,
    id: implementationId('test.feature-policy-plugin.cpu'),
    version: 1,
    support: 'fallback',
    semanticContract: 'test.feature-policy-plugin@1',
    requirements: [],
    dependencies: [],
    conflicts: [],
    cacheDomains: [],
    priority: 1,
    quality: { tier: 'test', rank: 1, notes: [] },
    estimate: () => ZERO_RESOURCE_BUDGET,
    prepare: async () => prepared,
    dispose: (value) => disposed.push(value),
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
        semanticContract: 'test.feature-policy-plugin@1',
        required: true,
        priority: 1
      }
    ],
    implementations: [implementation]
  };
}

import { describe, expect, test } from 'vitest';
import {
  FeaturePolicyRevisionTracker,
  ZERO_RESOURCE_BUDGET,
  type FeaturePolicyInput,
  type FeaturePolicySourceRevisions
} from '../../src/feature-policy';
import { createCapabilitySnapshot } from '../../src/rhi/core/capabilities';

const initialSources: FeaturePolicySourceRevisions = {
  capabilities: 1,
  profile: 1,
  registry: 1,
  budget: 1
};

describe('FeaturePolicyRevisionTracker', () => {
  test('emits the initial policy revision and skips an unchanged source vector', () => {
    const tracker = new FeaturePolicyRevisionTracker();

    expect(tracker.capture(initialSources, input())?.revision).toBe(1);
    expect(tracker.capture(initialSources, input())).toBeUndefined();
  });

  test('coalesces one or several advanced sources into one monotonic policy revision', () => {
    const tracker = new FeaturePolicyRevisionTracker({ initialPolicyRevision: 7 });
    tracker.capture(initialSources, input());

    const next = tracker.capture(
      { capabilities: 2, profile: 1, registry: 1, budget: 3 },
      input({ profileId: 'memory-constrained' })
    );

    expect(next?.revision).toBe(8);
    expect(next?.profileId).toBe('memory-constrained');
    expect(tracker.currentRevision).toBe(8);
  });

  test('rejects a stale source without consuming a policy revision', () => {
    const tracker = new FeaturePolicyRevisionTracker();
    tracker.capture(initialSources, input());

    expect(() => tracker.capture({ ...initialSources, profile: 0 }, input())).toThrow(
      'profile source revision regressed'
    );

    expect(tracker.currentRevision).toBe(1);
    expect(tracker.capture({ ...initialSources, profile: 2 }, input())?.revision).toBe(2);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid source revision %s',
    (revision) => {
      const tracker = new FeaturePolicyRevisionTracker();

      expect(() => tracker.capture({ ...initialSources, budget: revision }, input())).toThrow(
        'budget source revision must be a non-negative safe integer'
      );
      expect(tracker.currentRevision).toBeUndefined();
    }
  );

  test('rejects an initial policy revision outside the positive safe-integer range', () => {
    expect(() => new FeaturePolicyRevisionTracker({ initialPolicyRevision: 0 })).toThrow(
      'initial policy revision must be a positive safe integer'
    );
  });
});

function input(
  overrides: Partial<Omit<FeaturePolicyInput, 'revision'>> = {}
): Omit<FeaturePolicyInput, 'revision'> {
  return {
    schemaVersion: 1,
    profileId: 'default',
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
    requests: [],
    implementations: [],
    ...overrides
  };
}

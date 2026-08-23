import { describe, expect, test } from 'vitest';
import type { BindingLayoutPlan } from '../../src/rendering';
import { LayoutCache } from '../../src/rendering';

describe('LayoutCache', () => {
  test('returns exact misses then hits while isolating policy, target and device generation', () => {
    const cache = new LayoutCache();
    const plan = fixture();
    const base = {
      plan,
      layoutRevision: 3,
      featurePolicyHash: 'policy-a',
      target: 'webgpu' as const,
      deviceGeneration: 1
    };

    expect(cache.resolve(base).status).toBe('miss');
    expect(cache.resolve(base).status).toBe('hit');
    expect(cache.resolve({ ...base, featurePolicyHash: 'policy-b' }).status).toBe('miss');
    expect(cache.resolve({ ...base, deviceGeneration: 2 }).status).toBe('miss');
    expect(cache.resolve({ ...base, target: 'webgl2' }).status).toBe('miss');
    expect(cache.metrics()).toMatchObject({
      hits: 1,
      misses: 4,
      canonicalPlans: 1,
      loweredEntries: 4
    });
  });

  test('rejects same-id canonical collisions and snapshots caller-owned plan arrays', () => {
    const cache = new LayoutCache();
    const plan = mutableFixture();
    const request = {
      plan,
      layoutRevision: 1,
      featurePolicyHash: 'policy',
      target: 'webgpu' as const,
      deviceGeneration: 1
    };
    const first = cache.resolve(request);
    plan.groups.length = 0;

    expect(first.entry.plan.groups).toHaveLength(1);
    expect(Object.isFrozen(first.entry)).toBe(true);
    expect(Object.isFrozen(first.entry.plan.groups)).toBe(true);
    expect(() =>
      cache.resolve({ ...request, plan: { ...fixture(), id: request.plan.id, hash: 'other' } })
    ).toThrow(/collision/i);
  });

  test('invalidates lowered revisions or devices while retaining canonical CPU plans', () => {
    const cache = new LayoutCache();
    const plan = fixture();
    cache.resolve({
      plan,
      layoutRevision: 1,
      featurePolicyHash: 'policy',
      target: 'webgpu',
      deviceGeneration: 1
    });
    cache.resolve({
      plan,
      layoutRevision: 2,
      featurePolicyHash: 'policy',
      target: 'webgpu',
      deviceGeneration: 2
    });

    expect(cache.invalidateDeviceGeneration(1)).toBe(1);
    expect(cache.invalidateLayoutRevision(2)).toBe(1);
    expect(cache.metrics()).toMatchObject({
      canonicalPlans: 1,
      loweredEntries: 0,
      invalidations: 2
    });
  });
});

function fixture(): BindingLayoutPlan {
  return mutableFixture() as BindingLayoutPlan;
}

function mutableFixture() {
  return {
    id: 'layout:fixture' as BindingLayoutPlan['id'],
    shaderAbiVersion: 1,
    groups: [
      {
        group: 0,
        visibility: ['vertex'] as const,
        bindings: [
          {
            kind: 'uniform-buffer' as const,
            group: 0,
            binding: 0,
            access: 'read' as const,
            minimumByteSize: 64,
            bufferLayoutHash: 'buffer',
            dynamicOffset: false
          }
        ]
      }
    ],
    dynamicOffsetOrder: [],
    backendRequirements: [],
    hash: 'layout-hash'
  };
}

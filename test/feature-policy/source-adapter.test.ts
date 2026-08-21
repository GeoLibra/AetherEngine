import { describe, expect, test } from 'vitest';
import {
  FeaturePolicySourceAdapter,
  NullDevice,
  NullSurface,
  type RHISurfaceConfiguration,
  type SurfaceTarget
} from '../../src';

const configuration: RHISurfaceConfiguration = {
  format: 'rgba8unorm',
  colorSpace: 'srgb',
  alphaMode: 'opaque',
  width: 640,
  height: 360,
  presentMode: 'fifo'
};

describe('FeaturePolicySourceAdapter', () => {
  test('advances capabilities for first observation, resize, and device replacement only', () => {
    const adapter = new FeaturePolicySourceAdapter();
    const firstDevice = new NullDevice();
    const surface = new NullSurface(target());
    surface.configure(firstDevice, configuration, 1);

    expect(adapter.observeGraphics(firstDevice, surface)).toBe(true);
    expect(adapter.revisions.capabilities).toBe(1);
    expect(adapter.observeGraphics(firstDevice, surface)).toBe(false);
    expect(adapter.revisions.capabilities).toBe(1);

    surface.loseForTesting();
    expect(adapter.observeGraphics(firstDevice, surface)).toBe(true);
    expect(adapter.revisions.capabilities).toBe(2);

    surface.configure(firstDevice, { ...configuration, width: 800 }, 2);
    expect(adapter.observeGraphics(firstDevice, surface)).toBe(true);
    expect(adapter.revisions.capabilities).toBe(3);

    const replacement = new NullDevice();
    surface.configure(replacement, { ...configuration, width: 800 }, 3);
    expect(adapter.observeGraphics(replacement, surface)).toBe(true);
    expect(adapter.revisions.capabilities).toBe(4);
  });

  test('advances profile, registry, and budget revisions independently', () => {
    const adapter = new FeaturePolicySourceAdapter();

    expect(adapter.profileChanged()).toBe(1);
    expect(adapter.registryChanged()).toBe(1);
    expect(adapter.budgetChanged()).toBe(1);
    expect(adapter.budgetChanged()).toBe(2);

    expect(adapter.revisions).toEqual({
      capabilities: 0,
      profile: 1,
      registry: 1,
      budget: 2
    });
  });

  test('does not expose mutable revision state', () => {
    const adapter = new FeaturePolicySourceAdapter();
    const published = adapter.revisions as { profile: number };
    published.profile = 99;

    expect(adapter.revisions.profile).toBe(0);
  });

  test('fails before a source revision exceeds the safe-integer range', () => {
    const adapter = new FeaturePolicySourceAdapter({
      capabilities: 0,
      profile: Number.MAX_SAFE_INTEGER,
      registry: 0,
      budget: 0
    });

    expect(() => adapter.profileChanged()).toThrow(
      'FeaturePolicy profile source revision exhausted the safe-integer range'
    );
    expect(adapter.revisions.profile).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects an incomplete initial source vector at the public boundary', () => {
    expect(
      () =>
        new FeaturePolicySourceAdapter({
          capabilities: 0,
          profile: 0,
          registry: 0
        } as never)
    ).toThrow('budget source revision must be a non-negative safe integer');
  });
});

function target(): SurfaceTarget {
  return { id: Symbol('feature-policy-source'), kind: 'offscreen' };
}

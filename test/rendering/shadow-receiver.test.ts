import { describe, expect, test } from 'vitest';
import {
  computeShadowDepthBias,
  selectShadowCascade,
  visibilityFromDepthSamples
} from '../../src/rendering';

describe('directional shadow receiver reference', () => {
  test('selects the first cascade containing the positive view depth', () => {
    expect(selectShadowCascade(4, [5, 15, 40, 100])).toBe(0);
    expect(selectShadowCascade(15, [5, 15, 40, 100])).toBe(1);
    expect(selectShadowCascade(41, [5, 15, 40, 100])).toBe(3);
    expect(selectShadowCascade(101, [5, 15, 40, 100])).toBeUndefined();
  });

  test('increases bias at grazing angles and never drops below the constant term', () => {
    expect(computeShadowDepthBias(1, 0.001, 0.01)).toBeCloseTo(0.001);
    expect(computeShadowDepthBias(0, 0.001, 0.01)).toBeCloseTo(0.011);
  });

  test('returns the fraction of PCF taps that pass the depth comparison', () => {
    expect(visibilityFromDepthSamples(0.5, [0.4, 0.5, 0.6, 0.8])).toBe(0.75);
    expect(visibilityFromDepthSamples(0.5, [])).toBe(1);
  });
});

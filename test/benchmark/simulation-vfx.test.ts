import { describe, expect, test } from 'vitest';
import {
  createVFXSpawnBatch,
  evaluateVertexAnalyticVFX
} from '../../benchmark/simulation-vfx/model';

describe('simulation vfx benchmark oracle', () => {
  test('evaluates vertex analytic trajectory and lifetime predictably', () => {
    const batch = createVFXSpawnBatch(100, 0x1337);
    expect(batch).toHaveLength(100);

    const initial = evaluateVertexAnalyticVFX(batch, 0.0);
    expect(initial.activeCount).toBe(100);
    expect(initial.deadCount).toBe(0);

    const mid = evaluateVertexAnalyticVFX(batch, 2.0);
    expect(mid.activeCount + mid.deadCount).toBe(100);
    expect(mid.deadCount).toBeGreaterThan(0);

    const complete = evaluateVertexAnalyticVFX(batch, 10.0);
    expect(complete.activeCount).toBe(0);
    expect(complete.deadCount).toBe(100);
  });
});

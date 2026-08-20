import { describe, expect, test } from 'vitest';
import {
  createVFXSpawnBatch,
  evaluateVertexAnalyticVFX,
  evaluateVFXReferenceScalar,
  SimulationVFXSpawnRecord,
  VFX_GOLDEN_1000_SEED_1337_DT_05
} from '../../benchmark/simulation-vfx/model';

describe('simulation vfx benchmark oracle and lifecycle boundaries', () => {
  test('accurately evaluates pre-spawn, active, and post-death lifecycle states on hand-crafted fixture', () => {
    // 3 particles:
    // Particle 1: spawnTick = 0 (t = 0.0s), lifetime = 1.0s -> dies at t = 1.0s
    // Particle 2: spawnTick = 60 (t = 1.0s), lifetime = 1.0s -> dies at t = 2.0s
    // Particle 3: spawnTick = 120 (t = 2.0s), lifetime = 1.0s -> dies at t = 3.0s
    const fixture: readonly SimulationVFXSpawnRecord[] = [
      Object.freeze({
        id: 1,
        seed: 101,
        spawnTick: 0,
        lifetime: 1.0,
        position: [0, 0, 0] as const,
        velocity: [1, 0, 0] as const,
        baseSize: 1.0,
        colorRgba: [1, 0, 0, 1] as const
      }),
      Object.freeze({
        id: 2,
        seed: 102,
        spawnTick: 60,
        lifetime: 1.0,
        position: [0, 10, 0] as const,
        velocity: [0, 1, 0] as const,
        baseSize: 1.0,
        colorRgba: [0, 1, 0, 1] as const
      }),
      Object.freeze({
        id: 3,
        seed: 103,
        spawnTick: 120,
        lifetime: 1.0,
        position: [0, 0, 10] as const,
        velocity: [0, 0, 1] as const,
        baseSize: 1.0,
        colorRgba: [0, 0, 1, 1] as const
      })
    ];

    // t = 0.5s: particle 1 active, particles 2 & 3 unspawned
    const r05 = evaluateVFXReferenceScalar(fixture, 0.5);
    expect(r05.unspawnedCount).toBe(2);
    expect(r05.activeCount).toBe(1);
    expect(r05.deadCount).toBe(0);
    expect(r05.aliveIds).toEqual([1]);

    // t = 1.5s: particle 1 dead, particle 2 active, particle 3 unspawned
    const r15 = evaluateVFXReferenceScalar(fixture, 1.5);
    expect(r15.unspawnedCount).toBe(1);
    expect(r15.activeCount).toBe(1);
    expect(r15.deadCount).toBe(1);
    expect(r15.aliveIds).toEqual([2]);

    // t = 2.5s: particles 1 & 2 dead, particle 3 active
    const r25 = evaluateVFXReferenceScalar(fixture, 2.5);
    expect(r25.unspawnedCount).toBe(0);
    expect(r25.activeCount).toBe(1);
    expect(r25.deadCount).toBe(2);
    expect(r25.aliveIds).toEqual([3]);

    // t = 3.5s: all particles dead
    const r35 = evaluateVFXReferenceScalar(fixture, 3.5);
    expect(r35.unspawnedCount).toBe(0);
    expect(r35.activeCount).toBe(0);
    expect(r35.deadCount).toBe(3);
    expect(r35.aliveIds).toEqual([]);
  });

  test('vertex-analytic matches the independent scalar reference identically across lifetime slices', () => {
    const batch = createVFXSpawnBatch(100, 0x1337);
    expect(batch).toHaveLength(100);

    for (const dt of [0.0, 0.25, 0.5, 1.0, 1.5, 2.5, 5.0]) {
      const reference = evaluateVFXReferenceScalar(batch, dt);
      const subject = evaluateVertexAnalyticVFX(batch, dt);

      expect(subject.unspawnedCount).toBe(reference.unspawnedCount);
      expect(subject.activeCount).toBe(reference.activeCount);
      expect(subject.deadCount).toBe(reference.deadCount);
      expect(subject.stateChecksum).toBe(reference.stateChecksum);
      expect(subject.aliveIds).toEqual(reference.aliveIds);
    }
  });

  test('matches the hardcoded deterministic golden baseline', () => {
    const batch = createVFXSpawnBatch(1000, 0x1337);
    const result = evaluateVertexAnalyticVFX(batch, 0.5);

    expect(result.unspawnedCount).toBe(VFX_GOLDEN_1000_SEED_1337_DT_05.unspawnedCount);
    expect(result.activeCount).toBe(VFX_GOLDEN_1000_SEED_1337_DT_05.activeCount);
    expect(result.deadCount).toBe(VFX_GOLDEN_1000_SEED_1337_DT_05.deadCount);
    expect(result.stateChecksum).toBe(VFX_GOLDEN_1000_SEED_1337_DT_05.stateChecksum);
  });
});

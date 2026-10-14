import { expect, test } from 'vitest';
import { planAssetResidencyPressure } from '../../../src/assets/request-scheduler/residency-pressure';
import { applyAssetResidencyPressure } from '../../../src/assets/request-scheduler/residency-eviction';

test('reports owner refusals when ownership changes after planning', () => {
  const plan = planAssetResidencyPressure('cpu', 8, [
    {
      key: 'payload:v1',
      pool: 'cpu',
      bytes: 8,
      activeLeases: 0,
      activeSubmissions: 0,
      priority: 0,
      lastUseTick: 1,
      rebuildCost: 1
    }
  ]);
  expect(applyAssetResidencyPressure(plan, new Map([['cpu', { evict: () => null }]]))).toEqual({
    releasedBytes: 0,
    rejectedKeys: ['payload:v1']
  });
  expect(applyAssetResidencyPressure(plan, new Map([['cpu', { evict: () => 8 }]]))).toEqual({
    releasedBytes: 8,
    rejectedKeys: []
  });
  expect(() => applyAssetResidencyPressure(plan, new Map())).toThrow('no eviction owner');
});

test('protects leased/submitted resources and isolates CPU from device pools', () => {
  const base = {
    pool: 'cpu',
    bytes: 8,
    activeLeases: 0,
    activeSubmissions: 0,
    priority: 0,
    lastUseTick: 1,
    rebuildCost: 1
  };
  const inputs = [
    { ...base, key: 'leased', activeLeases: 1 },
    { ...base, key: 'submitted', activeSubmissions: 1 },
    { ...base, key: 'gpu', pool: 'gpu:1' },
    { ...base, key: 'warm', lastUseTick: 10 },
    { ...base, key: 'cold' }
  ];
  const original = structuredClone(inputs);
  const result = planAssetResidencyPressure('cpu', 12, inputs);
  expect(result.candidates.map((candidate) => candidate.key)).toEqual(['cold', 'warm']);
  expect(result.proposedBytes).toBe(16);
  expect(result.unmetBytes).toBe(0);
  expect(inputs).toEqual(original);
  expect(planAssetResidencyPressure('cpu', 20, inputs).unmetBytes).toBe(4);
  expect(planAssetResidencyPressure('cpu', 0, inputs).candidates).toEqual([]);
});

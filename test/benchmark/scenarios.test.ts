import { describe, expect, test } from 'vitest';
import {
  AETHER_FULL_CHANGE_SUBJECT,
  AETHER_ITERATE_ONLY_SUBJECT,
  AETHER_SUBJECT,
  AETHER_TABLE_STORAGE_SUBJECT,
  AETHER_WRITE_NO_FILTER_SUBJECT
} from '../../benchmark/adapters/aether';
import { RAW_AOS_SUBJECT } from '../../benchmark/adapters/raw-aos';
import { RAW_SOA_SUBJECT } from '../../benchmark/adapters/raw-soa';
import { SCENARIOS, createScenarioInputs } from '../../benchmark/scenarios/definitions';

const EXPECTED_SCENARIOS = [
  'dense-read',
  'dense-update',
  'selective-query',
  'query-cache',
  'entity-lifecycle',
  'component-migration',
  'change-filter',
  'relations'
];

describe('ECS benchmark scenarios', () => {
  test('defines the complete versioned scenario matrix', () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual(EXPECTED_SCENARIOS);
    expect(SCENARIOS.every((scenario) => scenario.version === 1)).toBe(true);
    expect(SCENARIOS.every((scenario) => scenario.scales.smoke.length > 0)).toBe(true);
  });

  test('creates deterministic inputs and explicit selectivity variants', () => {
    const selective = SCENARIOS.find((scenario) => scenario.id === 'selective-query')!;
    const first = createScenarioInputs(selective, 100, 1234);
    const second = createScenarioInputs(selective, 100, 1234);

    expect(first).toEqual(second);
    expect(first.map((input) => input.fraction)).toEqual([1, 0.1, 0.01]);
    expect(first.map((input) => input.matchCount)).toEqual([100, 10, 1]);
  });

  test.each(['dense-read', 'dense-update'] as const)(
    'produces equivalent %s checksums for raw and Aether public paths',
    (scenarioId) => {
      const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId)!;
      const input = createScenarioInputs(scenario, 32, 7)[0]!;
      const subjects = [RAW_AOS_SUBJECT, RAW_SOA_SUBJECT, AETHER_SUBJECT];
      const checksums = subjects.map((subject) => {
        const result = subject.prepare(scenario, input);
        expect(result.status).toBe('supported');
        if (result.status !== 'supported') throw new Error(result.reason);
        expect(result).toMatchObject({
          preparation: {
            setupMs: expect.any(Number),
            populationMs: expect.any(Number),
            queryPreparationMs: expect.any(Number)
          }
        });
        try {
          result.prepared.reset();
          return result.prepared.runIteration();
        } finally {
          result.prepared.dispose();
        }
      });

      expect(checksums[1]).toEqual(checksums[0]);
      expect(checksums[2]).toEqual(checksums[0]);
    }
  );

  test('reports structurally different raw scenarios as unsupported', () => {
    const migration = SCENARIOS.find((scenario) => scenario.id === 'component-migration')!;
    const input = createScenarioInputs(migration, 16, 1)[0]!;

    expect(RAW_AOS_SUBJECT.prepare(migration, input)).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('component migration')
    });
  });

  test.each(EXPECTED_SCENARIOS)('validates the Aether %s workload', (scenarioId) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId)!;
    for (const input of createScenarioInputs(scenario, 12, 3)) {
      const result = AETHER_SUBJECT.prepare(scenario, input);
      expect(result.status).toBe('supported');
      if (result.status !== 'supported') throw new Error(result.reason);
      try {
        expect(result.prepared.validate()).toEqual(result.prepared.expectedChecksum);
      } finally {
        result.prepared.dispose();
      }
    }
  });

  test('keeps direct Table storage as a diagnostic-only dense-update lane', () => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === 'dense-update')!;
    const input = createScenarioInputs(scenario, 24, 5)[0]!;
    const result = AETHER_TABLE_STORAGE_SUBJECT.prepare(scenario, input);

    expect(result.status).toBe('supported');
    if (result.status !== 'supported') throw new Error(result.reason);
    try {
      expect(result.prepared.validate()).toEqual(result.prepared.expectedChecksum);
    } finally {
      result.prepared.dispose();
    }
  });

  test.each([
    AETHER_ITERATE_ONLY_SUBJECT,
    AETHER_TABLE_STORAGE_SUBJECT,
    AETHER_WRITE_NO_FILTER_SUBJECT,
    AETHER_FULL_CHANGE_SUBJECT
  ])('validates dense-update diagnostic lane $id', (subject) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === 'dense-update')!;
    const input = createScenarioInputs(scenario, 24, 5)[0]!;
    const result = subject.prepare(scenario, input);

    expect(result.status).toBe('supported');
    if (result.status !== 'supported') throw new Error(result.reason);
    try {
      expect(result.prepared.validate()).toEqual(result.prepared.expectedChecksum);
    } finally {
      result.prepared.dispose();
    }
  });
});

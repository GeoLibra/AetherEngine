import { describe, expect, test } from 'vitest';
import { BITECS_SUBJECT } from '../../benchmark/adapters/bitecs';
import { KOOTA_SUBJECT } from '../../benchmark/adapters/koota';
import { SCENARIOS, createScenarioInputs } from '../../benchmark/scenarios/definitions';

describe.each([
  ['bitECS', BITECS_SUBJECT],
  ['Koota', KOOTA_SUBJECT]
] as const)('%s benchmark adapter', (_name, subject) => {
  test.each(['dense-read', 'dense-update', 'selective-query'] as const)(
    'validates equivalent %s work',
    (scenarioId) => {
      const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId)!;
      for (const input of createScenarioInputs(scenario, 24, 9)) {
        const result = subject.prepare(scenario, input);
        expect(result.status).toBe('supported');
        if (result.status !== 'supported') throw new Error(result.reason);
        expect(result).toHaveProperty('preparation.populationMs');
        try {
          expect(result.prepared.validate()).toEqual(result.prepared.expectedChecksum);
        } finally {
          result.prepared.dispose();
        }
      }
    }
  );
});

test('reports native capability differences explicitly', () => {
  const change = SCENARIOS.find((scenario) => scenario.id === 'change-filter')!;
  const input = createScenarioInputs(change, 20, 1)[2]!;

  expect(BITECS_SUBJECT.prepare(change, input)).toMatchObject({
    status: 'unsupported',
    reason: expect.stringContaining('native changed')
  });
  expect(KOOTA_SUBJECT.prepare(change, input).status).toBe('supported');
});

test.each(['query-cache', 'entity-lifecycle', 'component-migration', 'relations'] as const)(
  'exposes honest structural support for %s',
  (scenarioId) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId)!;
    const input = createScenarioInputs(scenario, 12, 2)[0]!;

    expect(BITECS_SUBJECT.prepare(scenario, input).status).toBe('supported');
    expect(KOOTA_SUBJECT.prepare(scenario, input).status).toBe('supported');
  }
);

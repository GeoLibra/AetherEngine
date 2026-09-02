import type { BenchmarkChecksum, BenchmarkScenario, ScenarioInput } from '../harness/types';

const DEFAULT_SCALES = Object.freeze({
  smoke: Object.freeze([100]),
  standard: Object.freeze([1_000, 10_000]),
  nightly: Object.freeze([10_000, 100_000])
});

const STRUCTURAL_SCALES = Object.freeze({
  smoke: Object.freeze([50]),
  standard: Object.freeze([500, 2_000]),
  nightly: Object.freeze([2_000, 10_000])
});

export const SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
  scenario('dense-read', 'Read Position and Velocity for every matching entity.', DEFAULT_SCALES),
  scenario(
    'dense-update',
    'Update Position from Velocity for every matching entity.',
    DEFAULT_SCALES
  ),
  scenario('selective-query', 'Update 100%, 10%, and 1% matching entities.', DEFAULT_SCALES),
  scenario(
    'query-cache',
    'Reuse a query and refresh it after new archetypes appear.',
    STRUCTURAL_SCALES
  ),
  scenario(
    'entity-lifecycle',
    'Spawn, despawn, and reuse a fixed entity batch.',
    STRUCTURAL_SCALES
  ),
  scenario(
    'component-migration',
    'Round-trip entities between two component signatures.',
    STRUCTURAL_SCALES
  ),
  scenario('change-filter', 'Consume native change filters at 100%, 10%, and 1%.', DEFAULT_SCALES),
  scenario('relations', 'Query and traverse deep and wide relation shapes.', STRUCTURAL_SCALES)
]);

export function createScenarioInputs(
  scenarioDefinition: BenchmarkScenario,
  scale: number,
  seed: number
): readonly ScenarioInput[] {
  assertScale(scale);
  const fractions =
    scenarioDefinition.id === 'selective-query' || scenarioDefinition.id === 'change-filter'
      ? [1, 0.1, 0.01]
      : [1];
  const shapes =
    scenarioDefinition.id === 'relations' ? (['deep', 'wide'] as const) : (['default'] as const);

  return Object.freeze(
    shapes.flatMap((shape) =>
      fractions.map((fraction) => {
        const matchCount = Math.max(1, Math.floor(scale * fraction));
        return Object.freeze({
          scenarioId: scenarioDefinition.id,
          scale,
          seed,
          seedOffset: Math.abs(seed | 0) % 13,
          fraction,
          matchCount,
          shape,
          caseId: `${scenarioDefinition.id}:${scale}:${fraction}:${shape}`
        });
      })
    )
  );
}

export function expectedDenseChecksum(
  input: ScenarioInput,
  mode: 'read' | 'update' | 'selective'
): BenchmarkChecksum {
  const count = mode === 'selective' ? input.matchCount : input.scale;
  let value = 0;
  for (let index = 0; index < count; index++) {
    const position = initialPosition(index, input.seedOffset);
    if (mode === 'read') {
      const velocity = initialVelocity(index);
      value += position.x + position.y + velocity.x + velocity.y;
    } else {
      const velocity = initialVelocity(index);
      value += position.x + velocity.x + position.y + velocity.y;
    }
  }
  return Object.freeze({ count, value });
}

export function expectedPositionChecksum(
  input: ScenarioInput,
  count = input.scale,
  updated = false
): BenchmarkChecksum {
  let value = 0;
  for (let index = 0; index < count; index++) {
    const position = initialPosition(index, input.seedOffset);
    const velocity = initialVelocity(index);
    value += position.x + position.y + (updated ? velocity.x + velocity.y : 0);
  }
  return Object.freeze({ count, value });
}

export function initialPosition(index: number, seedOffset: number): { x: number; y: number } {
  return { x: index + seedOffset, y: (index % 17) - seedOffset };
}

export function initialVelocity(index: number): { x: number; y: number } {
  return { x: (index % 3) + 1, y: (index % 5) - 2 };
}

function scenario(
  id: BenchmarkScenario['id'],
  description: string,
  scales: BenchmarkScenario['scales']
): BenchmarkScenario {
  return Object.freeze({ id, version: 1, description, scales });
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error(`Benchmark scale must be a positive integer, received ${scale}.`);
  }
}

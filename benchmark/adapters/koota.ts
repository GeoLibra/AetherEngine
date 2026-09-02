import { performance } from 'node:perf_hooks';
import {
  createChanged,
  createQuery,
  createWorld,
  relation,
  trait,
  type Entity,
  type World
} from 'koota';
import type { BenchmarkChecksum, BenchmarkScenario, ScenarioInput } from '../harness/types';
import {
  expectedDenseChecksum,
  expectedPositionChecksum,
  initialPosition,
  initialVelocity
} from '../scenarios/definitions';
import type {
  BenchmarkSubject,
  PreparationTimings,
  PreparedBenchmark,
  PrepareResult
} from './types';

export const KOOTA_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'koota',
  version: '0.6.6',
  prepare(scenario, input) {
    return scenario.id === 'relations'
      ? prepareRelations(input)
      : prepareComponents(scenario, input);
  }
});

function prepareComponents(scenario: BenchmarkScenario, input: ScenarioInput): PrepareResult {
  const definitionsStartedAt = performance.now();
  const Position = trait({ x: 0, y: 0 });
  const Velocity = trait({ x: 0, y: 0 });
  const Selected = trait();
  const Changed = createChanged();
  const definitionSetupMs = performance.now() - definitionsStartedAt;
  const queryStartedAt = performance.now();
  const denseQuery = createQuery(Position, Velocity);
  const selectedQuery = createQuery(Position, Velocity, Selected);
  const positionQuery = createQuery(Position);
  const changedQuery = createQuery(Position, Changed(Position));
  const queryPreparationMs = performance.now() - queryStartedAt;
  let world: World;
  let entities: Entity[] = [];
  let initialPreparation = ZERO_PREPARATION;

  const spawn = (index: number, includeVelocity = true): Entity => {
    const initial = initialPosition(index, input.seedOffset);
    const speed = initialVelocity(index);
    const entity = world.spawn(Position(initial));
    if (includeVelocity) entity.add(Velocity(speed));
    if (scenario.id === 'selective-query' && index < input.matchCount) entity.add(Selected);
    return entity;
  };

  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    entities = [];
    const setupMs = definitionSetupMs + performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      entities.push(
        spawn(index, scenario.id !== 'query-cache' && scenario.id !== 'component-migration')
      );
    }
    if (scenario.id === 'change-filter') world.query(changedQuery);
    if (recordPreparation) {
      initialPreparation = Object.freeze({
        setupMs,
        populationMs: performance.now() - populationStartedAt,
        queryPreparationMs
      });
    }
  };

  const runDense = (update: boolean, selective: boolean): BenchmarkChecksum => {
    if (selective) return runDenseMatches(world.query(selectedQuery), update);
    return runDenseMatches(world.query(denseQuery), update);
  };

  const runDenseMatches = (matches: readonly Entity[], update: boolean): BenchmarkChecksum => {
    let value = 0;
    for (const entity of matches) {
      const position = entity.get(Position)!;
      const velocity = entity.get(Velocity)!;
      if (update) {
        entity.set(Position, { x: position.x + velocity.x, y: position.y + velocity.y });
        value += position.x + velocity.x + position.y + velocity.y;
      } else {
        value += position.x + position.y + velocity.x + velocity.y;
      }
    }
    return checksum(matches.length, value);
  };

  const sumPositions = (matches: readonly Entity[]): BenchmarkChecksum => {
    let value = 0;
    for (const entity of matches) {
      const position = entity.get(Position)!;
      value += position.x + position.y;
    }
    return checksum(matches.length, value);
  };

  const run = (): BenchmarkChecksum => {
    switch (scenario.id) {
      case 'dense-read':
        return runDense(false, false);
      case 'dense-update':
        return runDense(true, false);
      case 'selective-query':
        return runDense(true, true);
      case 'query-cache':
        world.query(positionQuery);
        world.spawn(
          Position(initialPosition(input.scale, input.seedOffset)),
          Velocity(initialVelocity(input.scale))
        );
        world.spawn(Velocity(initialVelocity(input.scale + 1)));
        return sumPositions(world.query(positionQuery));
      case 'entity-lifecycle':
        for (const entity of entities) entity.destroy();
        entities = [];
        for (let index = 0; index < input.scale; index++) entities.push(spawn(index));
        return sumPositions(world.query(positionQuery));
      case 'component-migration':
        for (let index = 0; index < entities.length; index++) {
          entities[index]!.add(Velocity(initialVelocity(index)));
        }
        for (const entity of entities) entity.remove(Velocity);
        return sumPositions(world.query(positionQuery));
      case 'change-filter':
        for (let index = 0; index < input.matchCount; index++) {
          const entity = entities[index]!;
          const position = entity.get(Position)!;
          const velocity = initialVelocity(index);
          entity.set(Position, { x: position.x + velocity.x, y: position.y + velocity.y });
        }
        return sumPositions(world.query(changedQuery));
      case 'relations':
        throw new Error('Koota relations use a dedicated preparation path.');
    }
  };

  reset(true);
  return supported(
    prepared(
      expectedForScenario(scenario, input),
      reset,
      run,
      () => Object.freeze({ rowsExamined: world.entities.length }),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function prepareRelations(input: ScenarioInput): PrepareResult {
  const relationStartedAt = performance.now();
  const ChildOf = relation({ exclusive: true });
  const relationSetupMs = performance.now() - relationStartedAt;
  let world: World;
  let root: Entity;
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    root = world.spawn();
    const setupMs = relationSetupMs + performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    let parent = root;
    for (let index = 0; index < input.scale; index++) {
      const entity = world.spawn(ChildOf(input.shape === 'deep' ? parent : root));
      parent = entity;
    }
    if (recordPreparation) {
      initialPreparation = Object.freeze({
        setupMs,
        populationMs: performance.now() - populationStartedAt,
        queryPreparationMs: 0
      });
    }
  };
  const children = (parent: Entity): readonly Entity[] => world.query(ChildOf(parent));
  const run = (): BenchmarkChecksum => {
    const exactCount = children(root).length;
    const childrenCount = exactCount;
    let traversalCount = 0;
    const pending = [root];
    while (pending.length > 0) {
      const entity = pending.pop()!;
      traversalCount++;
      pending.push(...children(entity));
    }
    return checksum(exactCount, exactCount + childrenCount + traversalCount);
  };
  reset(true);
  const exactCount = input.shape === 'deep' ? 1 : input.scale;
  return supported(
    prepared(
      checksum(exactCount, exactCount * 2 + input.scale + 1),
      reset,
      run,
      () => Object.freeze({ relationEdges: input.scale }),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function expectedForScenario(scenario: BenchmarkScenario, input: ScenarioInput): BenchmarkChecksum {
  switch (scenario.id) {
    case 'dense-read':
      return expectedDenseChecksum(input, 'read');
    case 'dense-update':
      return expectedDenseChecksum(input, 'update');
    case 'selective-query':
      return expectedDenseChecksum(input, 'selective');
    case 'query-cache':
      return expectedPositionChecksum(input, input.scale + 1);
    case 'entity-lifecycle':
    case 'component-migration':
      return expectedPositionChecksum(input);
    case 'change-filter':
      return expectedPositionChecksum(input, input.matchCount, true);
    case 'relations':
      throw new Error('Relations use a dedicated checksum.');
  }
}

function prepared(
  expectedChecksum: BenchmarkChecksum,
  reset: () => void,
  runIteration: () => BenchmarkChecksum,
  counters: () => Readonly<Record<string, number>>,
  dispose: () => void
): PreparedBenchmark {
  return {
    expectedChecksum,
    reset,
    validate() {
      reset();
      return runIteration();
    },
    runIteration,
    counters,
    dispose
  };
}

function supported(
  value: PreparedBenchmark,
  preparation: PreparationTimings = ZERO_PREPARATION
): PrepareResult {
  return { status: 'supported', prepared: value, preparation };
}

function checksum(count: number, value: number): BenchmarkChecksum {
  return Object.freeze({ count, value });
}

const ZERO_PREPARATION: PreparationTimings = Object.freeze({
  setupMs: 0,
  populationMs: 0,
  queryPreparationMs: 0
});

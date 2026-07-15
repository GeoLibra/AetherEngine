import { performance } from 'node:perf_hooks';
import {
  ChildOf,
  World,
  type Entity,
  type QueryState
} from '../../src';
import type {
  BenchmarkChecksum,
  BenchmarkScenario,
  ScenarioInput
} from '../harness/types';
import {
  expectedDenseChecksum,
  expectedPositionChecksum,
  initialPosition,
  initialVelocity
} from '../scenarios/definitions';
import {
  BenchmarkPosition,
  BenchmarkSelected,
  BenchmarkVelocity,
  type BenchmarkVectorView
} from '../scenarios/components';
import type {
  BenchmarkSubject,
  PreparationTimings,
  PreparedBenchmark,
  PrepareResult
} from './types';
import { unsupported } from './types';

export const AETHER_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'aether-public',
  version: 'workspace',
  prepare(scenario, input) {
    switch (scenario.id) {
      case 'dense-read':
      case 'dense-update':
      case 'selective-query':
        return prepareDense(scenario, input);
      case 'query-cache':
        return prepareQueryCache(input);
      case 'entity-lifecycle':
        return prepareLifecycle(input);
      case 'component-migration':
        return prepareMigration(input);
      case 'change-filter':
        return prepareChangeFilter(input);
      case 'relations':
        return prepareRelations(input);
    }
  }
});

export { AETHER_TABLE_STORAGE_SUBJECT } from './aether-table-storage';

export const AETHER_ITERATE_ONLY_SUBJECT = diagnosticSubject(
  'aether-iterate-only',
  (scenario, input) => prepareDense({ ...scenario, id: 'dense-read' }, input)
);

export const AETHER_WRITE_NO_FILTER_SUBJECT = diagnosticSubject(
  'aether-write-no-filter',
  prepareDense
);

export const AETHER_FULL_CHANGE_SUBJECT = diagnosticSubject(
  'aether-full-change',
  (_scenario, input) => prepareChangeFilter(input)
);

function prepareDense(scenario: BenchmarkScenario, input: ScenarioInput): PrepareResult {
  const setupStartedAt = performance.now();
  const world = createWorld();
  const setupMs = performance.now() - setupStartedAt;
  const populationStartedAt = performance.now();
  for (let index = 0; index < input.scale; index++) {
    const builder = world
      .spawn()
      .insert(BenchmarkPosition, initialPosition(index, input.seedOffset))
      .insert(BenchmarkVelocity, initialVelocity(index));
    if (index < input.matchCount) builder.insert(BenchmarkSelected);
    builder.build();
  }
  const populationMs = performance.now() - populationStartedAt;
  const mode = scenario.id === 'dense-read' ? 'read' : scenario.id === 'dense-update' ? 'update' : 'selective';
  const queryStartedAt = performance.now();
  const query = world.createQueryState(
    [BenchmarkPosition, BenchmarkVelocity] as const,
    mode === 'selective' ? { with: [BenchmarkSelected] } : {}
  );
  const queryPreparationMs = performance.now() - queryStartedAt;
  const reset = (): void => {
    let index = 0;
    for (const [, position] of query) {
      const initial = initialPosition(index++, input.seedOffset);
      position.x = initial.x;
      position.y = initial.y;
    }
  };
  const run = (): BenchmarkChecksum => {
    let count = 0;
    let value = 0;
    for (const [, position, velocity] of query) {
      if (mode !== 'read') {
        position.x += velocity.x;
        position.y += velocity.y;
      }
      count++;
      value += position.x + position.y + (mode === 'read' ? velocity.x + velocity.y : 0);
    }
    return checksum(count, value);
  };
  return supported(
    createPrepared(
      expectedDenseChecksum(input, mode),
      reset,
      run,
      () => queryCounters(world, query),
      () => world.destroy()
    ),
    Object.freeze({ setupMs, populationMs, queryPreparationMs })
  );
}

function prepareQueryCache(input: ScenarioInput): PrepareResult {
  let world: World;
  let query: QueryState<readonly [typeof BenchmarkPosition]>;
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      world.spawn().insert(BenchmarkPosition, initialPosition(index, input.seedOffset)).build();
    }
    const populationMs = performance.now() - populationStartedAt;
    const queryStartedAt = performance.now();
    query = world.createQueryState([BenchmarkPosition] as const);
    const queryPreparationMs = performance.now() - queryStartedAt;
    if (recordPreparation) {
      initialPreparation = Object.freeze({ setupMs, populationMs, queryPreparationMs });
    }
  };
  const run = (): BenchmarkChecksum => {
    for (const _row of query) {
      // Warm the persistent QueryState before introducing new archetypes.
    }
    world
      .spawn()
      .insert(BenchmarkPosition, initialPosition(input.scale, input.seedOffset))
      .insert(BenchmarkVelocity, initialVelocity(input.scale))
      .build();
    world.spawn().insert(BenchmarkVelocity, initialVelocity(input.scale + 1)).build();
    let count = 0;
    let value = 0;
    for (const [, position] of query) {
      count++;
      value += position.x + position.y;
    }
    return checksum(count, value);
  };
  reset(true);
  return supported(
    createPrepared(
      expectedPositionChecksum(input, input.scale + 1),
      reset,
      run,
      () => queryCounters(world, query),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function prepareLifecycle(input: ScenarioInput): PrepareResult {
  let world: World;
  let entities: Entity[] = [];
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    entities = [];
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      entities.push(
        world.spawn().insert(BenchmarkPosition, initialPosition(index, input.seedOffset)).build()
      );
    }
    if (recordPreparation) {
      initialPreparation = Object.freeze({
        setupMs,
        populationMs: performance.now() - populationStartedAt,
        queryPreparationMs: 0
      });
    }
  };
  const run = (): BenchmarkChecksum => {
    for (const entity of entities) world.despawn(entity);
    entities = [];
    for (let index = 0; index < input.scale; index++) {
      entities.push(
        world.spawn().insert(BenchmarkPosition, initialPosition(index, input.seedOffset)).build()
      );
    }
    return sumPositions(world.createQueryState([BenchmarkPosition] as const));
  };
  reset(true);
  return supported(
    createPrepared(
      expectedPositionChecksum(input),
      reset,
      run,
      () => Object.freeze({ ...world.metrics() }),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function prepareMigration(input: ScenarioInput): PrepareResult {
  let world: World;
  let entities: Entity[] = [];
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    entities = [];
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      entities.push(
        world.spawn().insert(BenchmarkPosition, initialPosition(index, input.seedOffset)).build()
      );
    }
    if (recordPreparation) {
      initialPreparation = Object.freeze({
        setupMs,
        populationMs: performance.now() - populationStartedAt,
        queryPreparationMs: 0
      });
    }
  };
  const run = (): BenchmarkChecksum => {
    for (let index = 0; index < entities.length; index++) {
      world.insertComponent(entities[index]!, BenchmarkVelocity, initialVelocity(index));
    }
    for (const entity of entities) world.removeComponent(entity, BenchmarkVelocity);
    return sumPositions(world.createQueryState([BenchmarkPosition] as const));
  };
  reset(true);
  return supported(
    createPrepared(
      expectedPositionChecksum(input),
      reset,
      run,
      () => Object.freeze({ ...world.metrics() }),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function prepareChangeFilter(input: ScenarioInput): PrepareResult {
  let world: World;
  let entities: Entity[] = [];
  let query: QueryState<readonly [typeof BenchmarkPosition]>;
  let reader: ReturnType<World['createChangeReader']>;
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    entities = [];
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      entities.push(
        world.spawn().insert(BenchmarkPosition, initialPosition(index, input.seedOffset)).build()
      );
    }
    const populationMs = performance.now() - populationStartedAt;
    const queryStartedAt = performance.now();
    reader = world.createChangeReader({ from: 'current' });
    query = world.createQueryState([BenchmarkPosition] as const, { changed: [BenchmarkPosition] });
    const queryPreparationMs = performance.now() - queryStartedAt;
    if (recordPreparation) {
      initialPreparation = Object.freeze({ setupMs, populationMs, queryPreparationMs });
    }
  };
  const run = (): BenchmarkChecksum => {
    for (let index = 0; index < input.matchCount; index++) {
      const position = world.getComponent(entities[index]!, BenchmarkPosition)!;
      const velocity = initialVelocity(index);
      position.x += velocity.x;
      position.y += velocity.y;
    }
    return world.withChangeReader(reader, () => sumPositions(query));
  };
  reset(true);
  return supported(
    createPrepared(
      expectedPositionChecksum(input, input.matchCount, true),
      reset,
      run,
      () => queryCounters(world, query),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function prepareRelations(input: ScenarioInput): PrepareResult {
  let world: World;
  let root: Entity;
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    world?.destroy();
    world = createWorld();
    root = world.spawn().build();
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    let parent = root;
    for (let index = 0; index < input.scale; index++) {
      const entity = world.spawn().build();
      world.addRelation(entity, ChildOf, input.shape === 'deep' ? parent : root);
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
  const run = (): BenchmarkChecksum => {
    let exactCount = 0;
    for (const _row of world.createQueryState([] as const, { relation: [ChildOf, root] })) {
      exactCount++;
    }
    const childrenCount = world.getChildren(root).length;
    let traversalCount = 0;
    const pending = [root];
    while (pending.length > 0) {
      const entity = pending.pop()!;
      traversalCount++;
      pending.push(...world.getChildren(entity));
    }
    return checksum(exactCount, exactCount + childrenCount + traversalCount);
  };
  reset(true);
  const exactCount = input.shape === 'deep' ? 1 : input.scale;
  return supported(
    createPrepared(
      checksum(exactCount, exactCount * 2 + input.scale + 1),
      reset,
      run,
      () => Object.freeze({ ...world.metrics() }),
      () => world.destroy()
    ),
    initialPreparation
  );
}

function createWorld(): World {
  return new World()
    .registerComponent(BenchmarkPosition)
    .registerComponent(BenchmarkVelocity)
    .registerComponent(BenchmarkSelected);
}

function createPrepared(
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
  prepared: PreparedBenchmark,
  preparation: PreparationTimings = ZERO_PREPARATION
): PrepareResult {
  return { status: 'supported', prepared, preparation };
}

function sumPositions(
  query: Iterable<readonly [Entity, BenchmarkVectorView]>
): BenchmarkChecksum {
  let count = 0;
  let value = 0;
  for (const [, position] of query) {
    count++;
    value += position.x + position.y;
  }
  return checksum(count, value);
}

function queryCounters(
  world: World,
  query: QueryState<readonly [typeof BenchmarkPosition]> | QueryState<readonly [typeof BenchmarkPosition, typeof BenchmarkVelocity]>
): Readonly<Record<string, number>> {
  const metrics = world.metrics();
  return Object.freeze({
    rowsExamined: query.plan.rowFilters,
    matchedArchetypes: query.plan.matchedArchetypeIds.length,
    queryCacheHits: query.plan.cacheHits,
    migrations: metrics.migrations,
    allocatedRows: metrics.allocatedRows,
    liveRows: metrics.liveRows,
    chunks: metrics.chunks,
    relationEdges: metrics.relationEdges
  });
}

function checksum(count: number, value: number): BenchmarkChecksum {
  return Object.freeze({ count, value });
}

const ZERO_PREPARATION: PreparationTimings = Object.freeze({
  setupMs: 0,
  populationMs: 0,
  queryPreparationMs: 0
});

function diagnosticSubject(
  id: 'aether-iterate-only' | 'aether-write-no-filter' | 'aether-full-change',
  prepareDenseUpdate: (scenario: BenchmarkScenario, input: ScenarioInput) => PrepareResult
): BenchmarkSubject {
  return Object.freeze<BenchmarkSubject>({
    id,
    version: 'workspace-diagnostic',
    prepare(scenario, input) {
      if (scenario.id !== 'dense-update') {
        return unsupported(`${id} is a dense-update diagnostic lane only.`);
      }
      return prepareDenseUpdate(scenario, input);
    }
  });
}

import { performance } from 'node:perf_hooks';
import {
  addComponent,
  addEntity,
  commitRemovals,
  createRelation,
  createWorld,
  deleteWorld,
  query,
  registerQuery,
  removeComponent,
  removeEntity,
  type EntityId,
  type QueryResult,
  type World as BitecsWorld
} from 'bitecs';
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
import type {
  BenchmarkSubject,
  PreparationTimings,
  PreparedBenchmark,
  PrepareResult
} from './types';
import { unsupported } from './types';

interface VectorStore {
  readonly x: Float32Array;
  readonly y: Float32Array;
}

export const BITECS_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'bitecs',
  version: '0.4.0',
  prepare(scenario, input) {
    if (scenario.id === 'change-filter') {
      return unsupported('bitECS 0.4.0 has no equivalent native changed-value query contract.');
    }
    if (scenario.id === 'relations') return prepareRelations(input);
    return prepareComponents(scenario, input);
  }
});

function prepareComponents(scenario: BenchmarkScenario, input: ScenarioInput): PrepareResult {
  let world: BitecsWorld;
  let position: VectorStore;
  let velocity: VectorStore;
  let selected: object;
  let entities: EntityId[] = [];
  let initialPreparation = ZERO_PREPARATION;

  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    if (world) deleteWorld(world);
    world = createWorld();
    position = vectorStore(input.scale + 4);
    velocity = vectorStore(input.scale + 4);
    selected = {};
    entities = [];
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    if (scenario.id === 'entity-lifecycle') {
      populate(input.scale);
      if (recordPreparation) {
        initialPreparation = Object.freeze({
          setupMs,
          populationMs: performance.now() - populationStartedAt,
          queryPreparationMs: 0
        });
      }
      return;
    }
    populate(input.scale, scenario.id !== 'query-cache');
    if (scenario.id === 'component-migration') {
      for (const entity of entities) removeComponent(world, entity, velocity);
    }
    const populationMs = performance.now() - populationStartedAt;
    const queryStartedAt = performance.now();
    if (scenario.id === 'query-cache') registerQuery(world, [position]);
    const queryPreparationMs = performance.now() - queryStartedAt;
    if (recordPreparation) {
      initialPreparation = Object.freeze({ setupMs, populationMs, queryPreparationMs });
    }
  };

  const populate = (count: number, includeVelocity = true): void => {
    for (let index = 0; index < count; index++) {
      const entity = addEntity(world);
      entities.push(entity);
      addComponent(world, entity, position);
      if (includeVelocity) addComponent(world, entity, velocity);
      if (scenario.id === 'selective-query' && index < input.matchCount) {
        addComponent(world, entity, selected);
      }
      writeInitial(entity, index);
    }
  };

  const writeInitial = (entity: EntityId, index: number): void => {
    const initial = initialPosition(index, input.seedOffset);
    const speed = initialVelocity(index);
    position.x[entity] = initial.x;
    position.y[entity] = initial.y;
    velocity.x[entity] = speed.x;
    velocity.y[entity] = speed.y;
  };

  const run = (): BenchmarkChecksum => {
    switch (scenario.id) {
      case 'dense-read':
        return runDense(false, false);
      case 'dense-update':
        return runDense(true, false);
      case 'selective-query':
        return runDense(true, true);
      case 'query-cache': {
        query(world, [position]);
        const matching = addEntity(world);
        addComponent(world, matching, position);
        addComponent(world, matching, velocity);
        writeInitial(matching, input.scale);
        const nonMatching = addEntity(world);
        addComponent(world, nonMatching, velocity);
        return sumPositionQuery(query(world, [position]));
      }
      case 'entity-lifecycle':
        for (const entity of entities) removeEntity(world, entity);
        commitRemovals(world);
        entities = [];
        populate(input.scale);
        return sumPositionQuery(query(world, [position]));
      case 'component-migration':
        for (const entity of entities) addComponent(world, entity, velocity);
        for (const entity of entities) removeComponent(world, entity, velocity);
        return sumPositionQuery(query(world, [position]));
      case 'change-filter':
      case 'relations':
        throw new Error(`Unexpected bitECS component scenario ${scenario.id}.`);
    }
  };

  const runDense = (update: boolean, selective: boolean): BenchmarkChecksum => {
    const terms = selective ? [position, velocity, selected] : [position, velocity];
    const matches = query(world, terms);
    let value = 0;
    for (const entity of matches) {
      if (update) {
        position.x[entity] = position.x[entity]! + velocity.x[entity]!;
        position.y[entity] = position.y[entity]! + velocity.y[entity]!;
      }
      value += position.x[entity]! + position.y[entity]!;
      if (!update) value += velocity.x[entity]! + velocity.y[entity]!;
    }
    return checksum(matches.length, value);
  };

  const sumPositionQuery = (matches: QueryResult): BenchmarkChecksum => {
    let value = 0;
    for (const entity of matches) value += position.x[entity]! + position.y[entity]!;
    return checksum(matches.length, value);
  };

  reset(true);
  return supported(
    prepared(
      expectedForScenario(scenario, input),
      reset,
      run,
      () => Object.freeze({ rowsExamined: entities.length }),
      () => deleteWorld(world)
    ),
    initialPreparation
  );
}

function prepareRelations(input: ScenarioInput): PrepareResult {
  const relationStartedAt = performance.now();
  const ChildOf = createRelation<object>({ exclusive: true });
  const relationSetupMs = performance.now() - relationStartedAt;
  let world: BitecsWorld;
  let root: EntityId;
  let initialPreparation = ZERO_PREPARATION;
  const reset = (recordPreparation = false): void => {
    const setupStartedAt = performance.now();
    if (world) deleteWorld(world);
    world = createWorld();
    root = addEntity(world);
    const setupMs = relationSetupMs + performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    let parent = root;
    for (let index = 0; index < input.scale; index++) {
      const entity = addEntity(world);
      addComponent(world, entity, ChildOf(input.shape === 'deep' ? parent : root));
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
  const children = (parent: EntityId): QueryResult => query(world, [ChildOf(parent)]);
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
      () => deleteWorld(world)
    ),
    initialPreparation
  );
}

function expectedForScenario(
  scenario: BenchmarkScenario,
  input: ScenarioInput
): BenchmarkChecksum {
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
    case 'relations':
      throw new Error(`No component checksum for ${scenario.id}.`);
  }
}

function vectorStore(length: number): VectorStore {
  return { x: new Float32Array(length), y: new Float32Array(length) };
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

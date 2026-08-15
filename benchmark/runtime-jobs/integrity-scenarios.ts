import { CommandBuffer, EventChannel, StateStore, World, defineComponent } from '../../src';
import { JobMetricsCollector } from '../../src/jobs/metrics';

const BenchmarkValue = defineComponent<{ value: number }>({
  id: 'benchmark.runtime-integrity-value',
  version: 1,
  name: 'RuntimeIntegrityValue',
  fields: [{ id: 'value', name: 'value', type: 'u32' }]
});

export interface RuntimeIntegrityObservation {
  readonly semantic: Readonly<{
    commandValueSum: number;
    eventValueSum: number;
    stateCurrent: number;
    transitionReasonChecksum: string;
    jobFailures: number;
    jobHealth: string;
    jobFailureCount: number;
    workerUtilization: number;
  }>;
  readonly counters: Readonly<{
    clonedBundleEntries: number;
    appliedCommands: number;
    publishedEvents: number;
    stateRequests: number;
    metricsUpdates: number;
  }>;
  readonly checksum: string;
}

export function runRuntimeIntegritySubject(scale: number): RuntimeIntegrityObservation {
  assertScale(scale);
  const world = new World();
  world.registerComponent(BenchmarkValue);
  const commands = new CommandBuffer();
  const tickets = Array.from({ length: scale }, (_, value) => {
    const data = { value };
    const bundle = [{ component: BenchmarkValue, data }];
    const ticket = commands.spawn(bundle);
    data.value = scale + value;
    bundle[0] = { component: BenchmarkValue, data: { value: scale * 2 + value } };
    return ticket;
  });
  const applied = commands.apply(world, 'benchmark/runtime-integrity');
  const commandValueSum = tickets.reduce((sum, ticket) => {
    const entity = applied.resolve(ticket);
    return sum + (world.getComponent(entity, BenchmarkValue)?.value ?? Number.NaN);
  }, 0);

  const channel = new EventChannel<{ value: number }>({
    capacity: scale,
    retention: 'until-all-readers',
    overflow: 'error'
  });
  const reader = channel.createReader({ from: 'beginning' });
  for (let value = 0; value < scale; value++) {
    const event = { value };
    channel.publish(event);
    event.value = scale + value;
  }
  const events = channel.read(reader);
  const eventValueSum = events.reduce((sum, event) => sum + event.value, 0);

  const states = new StateStore(-1);
  for (let state = 0; state < scale; state++) states.request(state, `state-${state}`);
  const transitions = states.applyAll();

  const metrics = new JobMetricsCollector();
  for (let update = 0; update < scale - 1; update++) {
    metrics.recordFailure('benchmark-job', `failure-${update}`);
  }
  metrics.recordSuccess('benchmark-job');
  const metricSnapshot = metrics.snapshot(scale, 1, 1, 2);

  return observation(
    {
      commandValueSum,
      eventValueSum,
      stateCurrent: states.current,
      transitionReasonChecksum: checksum(transitions.map(({ reason }) => reason).join('|')),
      jobFailures: metricSnapshot.failures,
      jobHealth: metricSnapshot.healthByType['benchmark-job']?.status ?? 'missing',
      jobFailureCount: metricSnapshot.failuresByType['benchmark-job'] ?? 0,
      workerUtilization: metricSnapshot.workerUtilization
    },
    {
      clonedBundleEntries: scale,
      appliedCommands: applied.commandCount,
      publishedEvents: channel.diagnostics.published,
      stateRequests: transitions.length,
      metricsUpdates: scale
    }
  );
}

/** Closed-form oracle; it does not call CommandBuffer, EventChannel, StateStore, or JobMetrics. */
export function runRuntimeIntegrityReference(scale: number): RuntimeIntegrityObservation {
  assertScale(scale);
  const valueSum = (scale * (scale - 1)) / 2;
  const reasons = Array.from({ length: scale }, (_, state) => `state-${state}`);
  return observation(
    {
      commandValueSum: valueSum,
      eventValueSum: valueSum,
      stateCurrent: scale - 1,
      transitionReasonChecksum: checksum(reasons.join('|')),
      jobFailures: scale - 1,
      jobHealth: 'healthy',
      jobFailureCount: scale - 1,
      workerUtilization: 0.5
    },
    {
      clonedBundleEntries: scale,
      appliedCommands: scale,
      publishedEvents: scale,
      stateRequests: scale,
      metricsUpdates: scale
    }
  );
}

function observation(
  semantic: RuntimeIntegrityObservation['semantic'],
  counters: RuntimeIntegrityObservation['counters']
): RuntimeIntegrityObservation {
  const frozenSemantic = Object.freeze({ ...semantic });
  const frozenCounters = Object.freeze({ ...counters });
  return Object.freeze({
    semantic: frozenSemantic,
    counters: frozenCounters,
    checksum: checksum(JSON.stringify({ semantic: frozenSemantic, counters: frozenCounters }))
  });
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error('Runtime integrity benchmark scale must be a positive integer.');
  }
}

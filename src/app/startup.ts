import { isPromiseLike } from '../core';
import type { World } from '../ecs/world';
import { STARTUP_SCHEDULES } from './constants';
import { sortPlugins } from './plugin-graph';
import type { Schedule } from './schedule';
import {
  RegistrationTransaction,
  type RegistrationTransactionHost,
  removeRegistrations
} from './transaction';
import type {
  AppState,
  Plugin,
  PluginFinishContext,
  PluginPrepareContext,
  ReadonlyAppContext,
  RegistrationHandle,
  ScheduleLabel
} from './types';
import type { AppTelemetry } from './telemetry';

export interface StartupHost {
  readonly transactionHost: RegistrationTransactionHost;
  readonly schedules: ReadonlyMap<ScheduleLabel, Schedule>;
  readonly world: World;
  readonly telemetry?: AppTelemetry;
  createReadonlyContext(): ReadonlyAppContext;
  applyCommands(point: string): void;
  recordContributionCleanupError(error: unknown, pluginId: string): void;
}

export interface StartupRunResult {
  readonly orderedPlugins: readonly Plugin[];
}

/**
 * Orchestrates the cancellable startup pipeline:
 * 1. Topological plugin preflight & synchronous build transactions
 * 2. Cancellable asynchronous prepare with AbortSignal
 * 3. Synchronous finish with complete registry read context
 * 4. Pre-startup schedule compilation barrier (catches cycles & missing targets)
 * 5. World start and PreStartup/Startup/PostStartup execution
 */
export async function runStartupPipeline(
  host: StartupHost,
  pendingPlugins: readonly Plugin[],
  builtPlugins: Plugin[],
  registrations: RegistrationHandle[],
  signal: AbortSignal,
  updateState: (state: AppState) => void
): Promise<StartupRunResult> {
  const { transactionHost, schedules, world, telemetry } = host;

  // 1. Building phase
  updateState('building');
  assertNotAborted(signal);
  const orderedPlugins = sortPlugins(pendingPlugins);

  for (const plugin of orderedPlugins) {
    assertNotAborted(signal);
    const transaction = new RegistrationTransaction(transactionHost, plugin.id);
    const t0 = telemetry?.now() ?? 0;
    telemetry?.recordPluginStart(plugin.id, 'build');

    try {
      const result = plugin.build(transaction) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error(`Plugin "${plugin.id}" build() must be synchronous.`);
      }
      registrations.push(...transaction.commit());
      builtPlugins.push(plugin);
      telemetry?.recordPluginComplete(plugin.id, 'build', (telemetry?.now() ?? 0) - t0);
    } catch (error) {
      telemetry?.recordPluginFail(plugin.id, 'build', (telemetry?.now() ?? 0) - t0, error);
      rollbackTransaction(transaction, plugin.id, host);
      throw error;
    }
  }

  // 2. Preparation phase (waiting-ready)
  updateState('waiting-ready');
  assertNotAborted(signal);
  const readonlyContext = host.createReadonlyContext();

  for (const plugin of orderedPlugins) {
    assertNotAborted(signal);
    if (!plugin.prepare) continue;

    const prepareContext: PluginPrepareContext = Object.freeze({
      ...readonlyContext,
      pluginId: plugin.id,
      signal
    });

    const t0 = telemetry?.now() ?? 0;
    telemetry?.recordPluginStart(plugin.id, 'prepare');

    try {
      await plugin.prepare(prepareContext);
      if (signal.aborted) {
        telemetry?.recordPluginCancel(plugin.id, 'prepare', (telemetry?.now() ?? 0) - t0);
        throw new Error(`Plugin "${plugin.id}" preparation was aborted.`);
      }
      telemetry?.recordPluginComplete(plugin.id, 'prepare', (telemetry?.now() ?? 0) - t0);
    } catch (error) {
      if (signal.aborted) {
        telemetry?.recordPluginCancel(plugin.id, 'prepare', (telemetry?.now() ?? 0) - t0);
      } else {
        telemetry?.recordPluginFail(plugin.id, 'prepare', (telemetry?.now() ?? 0) - t0, error);
      }
      throw error;
    }
  }

  // 3. Synchronous finish phase (starting)
  updateState('starting');
  assertNotAborted(signal);

  for (const plugin of orderedPlugins) {
    assertNotAborted(signal);
    if (!plugin.finish) continue;

    const transaction = new RegistrationTransaction(transactionHost, plugin.id);
    const finishContext: PluginFinishContext = Object.freeze(
      Object.assign(Object.create(transaction), {
        pluginId: plugin.id,
        get state(): AppState {
          return readonlyContext.state;
        },
        getResource: readonlyContext.getResource.bind(readonlyContext),
        getService: readonlyContext.getService.bind(readonlyContext),
        listExtensions: readonlyContext.listExtensions.bind(readonlyContext)
      })
    );

    const t0 = telemetry?.now() ?? 0;
    telemetry?.recordPluginStart(plugin.id, 'finish');

    try {
      const result = plugin.finish(finishContext) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error(`Plugin "${plugin.id}" finish() must be synchronous.`);
      }
      registrations.push(...transaction.commit());
      telemetry?.recordPluginComplete(plugin.id, 'finish', (telemetry?.now() ?? 0) - t0);
    } catch (error) {
      telemetry?.recordPluginFail(plugin.id, 'finish', (telemetry?.now() ?? 0) - t0, error);
      rollbackTransaction(transaction, plugin.id, host);
      throw error;
    }
  }

  // 4. Pre-Startup Schedule Compilation Barrier
  assertNotAborted(signal);
  for (const schedule of schedules.values()) {
    const t0 = telemetry?.now() ?? 0;
    telemetry?.recordScheduleCompileStart(schedule.label);
    try {
      const compiled = schedule.compile();
      telemetry?.recordScheduleCompileComplete(
        schedule.label,
        (telemetry?.now() ?? 0) - t0,
        compiled.length
      );
    } catch (error) {
      telemetry?.recordScheduleCompileFail(schedule.label, (telemetry?.now() ?? 0) - t0, error);
      throw error;
    }
  }

  // 5. World start and startup systems
  assertNotAborted(signal);
  world.start();
  for (const label of STARTUP_SCHEDULES) {
    assertNotAborted(signal);
    const schedule = schedules.get(label as ScheduleLabel);
    if (schedule) {
      await schedule.run(world, telemetry);
      host.applyCommands(`after:${label}`);
    }
  }

  return { orderedPlugins };
}

function rollbackTransaction(
  transaction: RegistrationTransaction,
  pluginId: string,
  host: StartupHost
): void {
  try {
    transaction.rollback();
  } catch (error) {
    host.recordContributionCleanupError(error, pluginId);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('App startup was cancelled.');
  }
}

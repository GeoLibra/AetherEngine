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
import type { ResourceToken } from '../ecs/types';
import type { SchemaMigration, TypeSchema } from '../schema/types';
import type { ObserverDescriptor } from '../ecs/observer';
import type { EventChannel } from '../events/event-channel';
import type { StateStore } from '../events/state-store';
import type {
  AppScope,
  AppState,
  CommandApplyPointDescriptor,
  ExtensionContribution,
  ExtensionPoint,
  ExtensionSnapshot,
  Plugin,
  PluginFinishContext,
  PluginPrepareContext,
  ReadonlyAppContext,
  RegistrationHandle,
  ScheduleLabel,
  ServiceRegistration,
  ServiceToken,
  SystemDescriptor,
  SystemSetDescriptor
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
    const finishContext = createFinishContext(transaction, readonlyContext, plugin.id);

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
      assertNotAborted(signal);
      host.applyCommands(`after:${label}`);
    }
  }
  assertNotAborted(signal);

  return { orderedPlugins };
}

class FinishContextFacade implements PluginFinishContext {
  readonly pluginId: string;

  constructor(
    private readonly transaction: RegistrationTransaction,
    private readonly readonlyContext: ReadonlyAppContext,
    pluginId: string
  ) {
    this.pluginId = pluginId;
  }

  get state(): AppState {
    return this.readonlyContext.state;
  }

  getResource<T>(token: ResourceToken<T>): T | undefined {
    return this.readonlyContext.getResource(token);
  }

  getService<T>(token: ServiceToken<T>, scope?: AppScope): T {
    return this.readonlyContext.getService(token, scope);
  }

  listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[] {
    return this.readonlyContext.listExtensions(point);
  }

  addSystem(stage: ScheduleLabel, descriptor: SystemDescriptor): void {
    this.transaction.addSystem(stage, descriptor);
  }

  addSystemSet(stage: ScheduleLabel, descriptor: SystemSetDescriptor): void {
    this.transaction.addSystemSet(stage, descriptor);
  }

  addCommandApplyPoint(stage: ScheduleLabel, descriptor: CommandApplyPointDescriptor): void {
    this.transaction.addCommandApplyPoint(stage, descriptor);
  }

  insertResource<T>(token: ResourceToken<T>, resource: T): void {
    this.transaction.insertResource(token, resource);
  }

  replaceResource<T>(token: ResourceToken<T>, resource: T): void {
    this.transaction.replaceResource(token, resource);
  }

  provideService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void {
    this.transaction.provideService(token, registration);
  }

  replaceService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void {
    this.transaction.replaceService(token, registration);
  }

  addExtension<T>(point: ExtensionPoint<T>, contribution: ExtensionContribution<T>): void {
    this.transaction.addExtension(point, contribution);
  }

  registerSchema<T>(schema: TypeSchema<T>): void {
    this.transaction.registerSchema(schema);
  }

  registerSchemaMigration(migration: SchemaMigration): void {
    this.transaction.registerSchemaMigration(migration);
  }

  addObserver<TView extends object>(descriptor: ObserverDescriptor<TView>): void {
    this.transaction.addObserver(descriptor);
  }

  addEventChannel<T>(id: string, channel: EventChannel<T>): void {
    this.transaction.addEventChannel(id, channel);
  }

  addStateStore<S>(id: string, store: StateStore<S>): void {
    this.transaction.addStateStore(id, store);
  }

  deferCleanup(dispose: () => void): void {
    this.transaction.deferCleanup(dispose);
  }
}

function createFinishContext(
  transaction: RegistrationTransaction,
  readonlyContext: ReadonlyAppContext,
  pluginId: string
): PluginFinishContext {
  return new FinishContextFacade(transaction, readonlyContext, pluginId);
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

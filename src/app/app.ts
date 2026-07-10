import type { ResourceType } from '../ecs/types';
import { World } from '../ecs/world';
import { DEFAULT_SCHEDULES, FRAME_SCHEDULES, STARTUP_SCHEDULES } from './constants';
import { createLifecycleDiagnostic } from './lifecycle';
import { sortPlugins } from './plugin-graph';
import { ExtensionRegistry, ServiceRegistry } from './registry';
import type { AppExit, FrameOutcome, Runner, RunnerContext } from './runner';
import { Schedule } from './schedule';
import { RegistrationTransaction, removeRegistrations } from './transaction';
import type {
  AppScope,
  AppState,
  DestroyResult,
  ExtensionPoint,
  ExtensionSnapshot,
  LifecycleDiagnostic,
  Plugin,
  PluginGroup,
  ReadonlyAppContext,
  RegistrationHandle,
  ScheduleLabel,
  ServiceToken,
  ShutdownContext
} from './types';

/** V2 composition root. Structural mutation is available only inside plugin transactions. */
export class App {
  private readonly world = new World();
  private readonly schedules = new Map<ScheduleLabel, Schedule>();
  private readonly services = new ServiceRegistry();
  private readonly extensions = new ExtensionRegistry();
  private readonly pendingPlugins: Plugin[] = [];
  private readonly builtPlugins: Plugin[] = [];
  private readonly registrations: RegistrationHandle[] = [];
  private readonly diagnostics: LifecycleDiagnostic[] = [];
  private readonly transactionHost = {
    world: this.world,
    schedules: this.schedules,
    services: this.services,
    extensions: this.extensions
  };

  private currentState: AppState = 'created';
  private startupPromise?: Promise<void>;
  private destroyPromise?: Promise<DestroyResult>;
  private activeRunner: Runner | undefined;
  private activeRunPromise: Promise<AppExit> | undefined;
  private stopReason = 'requested';
  private frameCount = 0;

  constructor() {
    for (const label of DEFAULT_SCHEDULES) {
      this.schedules.set(label, new Schedule(label));
    }
  }

  get state(): AppState {
    return this.currentState;
  }

  addPlugin(plugin: Plugin): this {
    this.assertCreated('add plugin');
    this.pendingPlugins.push(plugin);
    return this;
  }

  addPlugins(plugins: readonly Plugin[] | PluginGroup): this {
    this.assertCreated('add plugins');
    const entries = 'plugins' in plugins ? plugins.plugins() : plugins;
    this.pendingPlugins.push(...entries);
    return this;
  }

  hasPlugin(id: string): boolean {
    return this.pendingPlugins.some((plugin) => plugin.id === id);
  }

  getResource<T extends object>(type: ResourceType<T>): T | undefined {
    return this.world.getResource(type);
  }

  getService<T>(token: ServiceToken<T>, scope?: AppScope): T {
    return scope === undefined ? this.services.get(token) : this.services.get(token, scope);
  }

  listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[] {
    return this.extensions.list(point);
  }

  startup(): Promise<void> {
    if (this.currentState === 'running') {
      return this.startupPromise ?? Promise.resolve();
    }
    if (
      this.currentState === 'building' ||
      this.currentState === 'waiting-ready' ||
      this.currentState === 'starting'
    ) {
      return this.startupPromise as Promise<void>;
    }
    if (this.currentState !== 'created') {
      return Promise.reject(
        new Error(`Cannot start App while it is in state "${this.currentState}".`)
      );
    }

    const startup = this.startupInternal();
    this.startupPromise = startup;
    return startup;
  }

  stop(reason = 'requested'): void {
    if (this.currentState !== 'running') {
      return;
    }
    this.stopReason = reason;
    this.currentState = 'stopping';
    if (this.activeRunner) {
      this.activeRunner.requestStop(reason);
    } else {
      this.currentState = 'stopped';
    }
  }

  run(runner: Runner): Promise<AppExit> {
    if (this.activeRunPromise) {
      return Promise.reject(new Error('Runner is already active for this App.'));
    }
    const execution = this.runInternal(runner);
    let tracked: Promise<AppExit>;
    tracked = execution.finally(() => {
      if (this.activeRunPromise === tracked) {
        this.activeRunPromise = undefined;
      }
    });
    this.activeRunPromise = tracked;
    return tracked;
  }

  destroy(): Promise<DestroyResult> {
    if (!this.destroyPromise) {
      this.destroyPromise = this.destroyInternal();
    }
    return this.destroyPromise;
  }

  private async startupInternal(): Promise<void> {
    this.currentState = 'building';
    try {
      const orderedPlugins = sortPlugins(this.pendingPlugins);
      for (const plugin of orderedPlugins) {
        const transaction = new RegistrationTransaction(this.transactionHost, plugin.id);
        try {
          const result = plugin.build(transaction) as unknown;
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error(`Plugin "${plugin.id}" build() must be synchronous.`);
          }
          this.registrations.push(...transaction.commit());
          this.builtPlugins.push(plugin);
        } catch (error) {
          this.rollbackTransaction(transaction, plugin.id);
          throw error;
        }
      }

      this.currentState = 'waiting-ready';
      const readonlyContext = this.createReadonlyContext();
      for (const plugin of orderedPlugins) {
        if ((await plugin.ready?.(readonlyContext)) === false) {
          throw new Error(`Plugin "${plugin.id}" reported that it is not ready.`);
        }
      }

      this.currentState = 'starting';
      for (const plugin of orderedPlugins) {
        if (!plugin.finish) {
          continue;
        }
        const transaction = new RegistrationTransaction(this.transactionHost, plugin.id);
        let committed: readonly RegistrationHandle[] | undefined;
        try {
          const result = plugin.finish(transaction);
          // Structural registration ends when finish() returns; only its async work may continue.
          committed = transaction.commit();
          await result;
          this.registrations.push(...committed);
        } catch (error) {
          if (committed) {
            for (const cleanupError of removeRegistrations(committed)) {
              this.diagnostics.push(
                createLifecycleDiagnostic('contribution-cleanup', cleanupError, plugin.id)
              );
            }
          } else {
            this.rollbackTransaction(transaction, plugin.id);
          }
          throw error;
        }
      }

      for (const label of STARTUP_SCHEDULES) {
        await this.schedules.get(label)?.run(this.world);
      }
      this.currentState = 'running';
    } catch (error) {
      this.currentState = 'failed';
      this.diagnostics.push(createLifecycleDiagnostic('startup', error));
      await this.shutdownBuiltPlugins('startup-failed');
      await this.disposeAndRemoveContributions();
      throw error;
    }
  }

  private async destroyInternal(): Promise<DestroyResult> {
    if (
      this.startupPromise &&
      (this.currentState === 'building' ||
        this.currentState === 'waiting-ready' ||
        this.currentState === 'starting')
    ) {
      try {
        await this.startupPromise;
      } catch {
        // Startup already recorded its primary failure and performed cleanup.
      }
    }

    if (this.activeRunPromise) {
      this.stop('destroy');
      try {
        await this.activeRunPromise;
      } catch {
        // Runtime failure remains the primary failure and is already diagnosed.
      }
    } else if (this.currentState === 'running') {
      this.stop('destroy');
    }
    if (this.currentState !== 'failed' && this.currentState !== 'destroyed') {
      this.stopReason = this.currentState === 'created' ? 'destroyed-before-startup' : this.stopReason;
    }

    await this.shutdownBuiltPlugins(this.stopReason);
    await this.disposeAndRemoveContributions();
    this.pendingPlugins.length = 0;
    this.currentState = 'destroyed';
    return Object.freeze({ diagnostics: Object.freeze([...this.diagnostics]) });
  }

  private createReadonlyContext(): ReadonlyAppContext {
    const app = this;
    return Object.freeze({
      get state(): AppState {
        return app.state;
      },
      getResource<T extends object>(type: ResourceType<T>): T | undefined {
        return app.getResource(type);
      },
      getService<T>(token: ServiceToken<T>, scope?: AppScope): T {
        return app.getService(token, scope);
      },
      listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[] {
        return app.listExtensions(point);
      }
    });
  }

  private async runInternal(runner: Runner): Promise<AppExit> {
    if (this.currentState === 'created') {
      await this.startup();
    } else if (
      this.currentState === 'building' ||
      this.currentState === 'waiting-ready' ||
      this.currentState === 'starting'
    ) {
      await this.startup();
    }
    if (this.currentState !== 'running') {
      throw new Error(`Cannot run App while it is in state "${this.currentState}".`);
    }

    this.activeRunner = runner;
    const app = this;
    const context: RunnerContext = Object.freeze({
      get stopRequested(): boolean {
        return app.state === 'stopping' || app.state === 'failed';
      },
      frame(): FrameOutcome {
        return app.executeFrame();
      }
    });

    try {
      const exit = await runner.run(context);
      if (this.currentState === 'running') {
        this.stopReason = exit.reason;
        this.currentState = 'stopping';
      }
      if (this.currentState === 'stopping') {
        this.currentState = 'stopped';
      }
      return Object.freeze({ reason: this.stopReason, frames: exit.frames });
    } catch (error) {
      runner.requestStop('runner-error');
      this.currentState = 'failed';
      this.diagnostics.push(createLifecycleDiagnostic('runtime', error));
      throw error;
    } finally {
      if (this.activeRunner === runner) {
        this.activeRunner = undefined;
      }
    }
  }

  private executeFrame(): FrameOutcome {
    let primaryError: unknown;
    let failed = false;
    const cleanupErrors: unknown[] = [];
    try {
      for (const label of FRAME_SCHEDULES) {
        this.schedules.get(label)?.runSync(this.world, 'frame');
      }
    } catch (error) {
      failed = true;
      primaryError = error;
    } finally {
      cleanupErrors.push(...this.services.clearFrameScoped());
      try {
        this.world.clearTrackers();
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const error of cleanupErrors) {
        this.diagnostics.push(createLifecycleDiagnostic('frame-cleanup', error));
      }
    }

    if (failed) {
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Frame cleanup failed.');
    }
    this.frameCount++;
    return Object.freeze({ frame: this.frameCount });
  }

  private createShutdownContext(pluginId: string, reason: string): ShutdownContext {
    const readonly = this.createReadonlyContext();
    return Object.freeze({
      ...readonly,
      pluginId,
      reason
    });
  }

  private async shutdownBuiltPlugins(reason: string): Promise<void> {
    for (const plugin of [...this.builtPlugins].reverse()) {
      try {
        await plugin.shutdown?.(this.createShutdownContext(plugin.id, reason));
      } catch (error) {
        this.diagnostics.push(createLifecycleDiagnostic('shutdown', error, plugin.id));
      }
    }
    this.builtPlugins.length = 0;
  }

  private async disposeAndRemoveContributions(): Promise<void> {
    for (const error of await this.services.disposeAll()) {
      this.diagnostics.push(createLifecycleDiagnostic('service-disposal', error));
    }
    for (const error of removeRegistrations(this.registrations)) {
      this.diagnostics.push(createLifecycleDiagnostic('contribution-cleanup', error));
    }
    this.registrations.length = 0;
    this.services.clearRegistrations();
    this.extensions.clear();
  }

  private rollbackTransaction(transaction: RegistrationTransaction, pluginId: string): void {
    try {
      transaction.rollback();
    } catch (error) {
      this.diagnostics.push(
        createLifecycleDiagnostic('contribution-cleanup', error, pluginId)
      );
    }
  }

  private assertCreated(operation: string): void {
    if (this.currentState !== 'created') {
      throw new Error(`Cannot ${operation} while App is in state "${this.currentState}".`);
    }
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

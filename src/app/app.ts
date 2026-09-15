import type { ResourceToken } from '../ecs/types';
import { World } from '../ecs/world';
import { CommandBufferResource } from '../ecs/command-buffer';
import { DiagnosticStoreResource } from '../diagnostics/store';
import { DEFAULT_SCHEDULES } from './constants';
import { createLifecycleDiagnostic } from './lifecycle';
import { ExtensionRegistry, ServiceRegistry } from './registry';
import type { AppExit, FrameOutcome, Runner, RunnerContext } from './runner';
import { Schedule } from './schedule';
import { removeRegistrations } from './transaction';
import { AppTelemetry } from './telemetry';
import { runStartupPipeline, type StartupHost } from './startup';
import { executeEngineFrame, type FrameHost } from './frame';
import type {
  AppScope,
  AppState,
  AppTelemetryOptions,
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

export interface AppOptions {
  readonly telemetry?: AppTelemetryOptions;
}

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
  private readonly telemetry: AppTelemetry;
  private readonly abortController = new AbortController();

  private currentState: AppState = 'created';
  private startupPromise?: Promise<void> | undefined;
  private destroyPromise?: Promise<DestroyResult> | undefined;
  private activeRunner?: Runner | undefined;
  private activeRunPromise?: Promise<AppExit> | undefined;
  private stopReason = 'requested';
  private frameCount = 0;

  constructor(options: AppOptions = {}) {
    this.telemetry = new AppTelemetry(options.telemetry);
    for (const label of DEFAULT_SCHEDULES) {
      this.schedules.set(label, new Schedule(label));
    }
  }

  get state(): AppState {
    return this.currentState;
  }

  get telemetryEvents(): AppTelemetry {
    return this.telemetry;
  }

  addPlugin(plugin: Plugin): this {
    this.assertCreated('add plugin');
    this.pendingPlugins.push(createOwnedPluginRecord(plugin));
    return this;
  }

  addPlugins(plugins: readonly Plugin[] | PluginGroup): this {
    this.assertCreated('add plugins');
    const entries = 'plugins' in plugins ? plugins.plugins() : plugins;
    for (const entry of entries) {
      this.addPlugin(entry);
    }
    return this;
  }

  hasPlugin(id: string): boolean {
    return this.pendingPlugins.some((p) => p.id === id);
  }

  getResource<T>(token: ResourceToken<T>): T | undefined {
    return this.world.getResource(token);
  }

  getService<T>(token: ServiceToken<T>, scope?: AppScope): T {
    return scope === undefined ? this.services.get(token) : this.services.get(token, scope);
  }

  listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[] {
    return this.extensions.list(point);
  }

  startup(): Promise<void> {
    if (this.destroyPromise) {
      return Promise.reject(
        new Error(
          this.currentState === 'destroyed'
            ? 'Cannot start App while it is in state "destroyed".'
            : 'Cannot start App while it is being destroyed.'
        )
      );
    }
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
    if (this.currentState !== 'running') return;
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
      this.abortController.abort();
      this.destroyPromise = this.destroyInternal();
    }
    return this.destroyPromise;
  }

  private async startupInternal(): Promise<void> {
    const startupHost: StartupHost = {
      transactionHost: {
        world: this.world,
        schedules: this.schedules,
        services: this.services,
        extensions: this.extensions
      },
      schedules: this.schedules,
      world: this.world,
      telemetry: this.telemetry,
      createReadonlyContext: () => this.createReadonlyContext(),
      applyCommands: (point) => {
        const commands = this.world.getResource(CommandBufferResource);
        if (commands && commands.length > 0) {
          commands.apply(this.world, point);
        }
      },
      recordContributionCleanupError: (err, id) => {
        this.recordLifecycleDiagnostic('contribution-cleanup', err, id);
      }
    };

    try {
      await runStartupPipeline(
        startupHost,
        this.pendingPlugins,
        this.builtPlugins,
        this.registrations,
        this.abortController.signal,
        (s) => {
          this.currentState = s;
        }
      );
      this.currentState = 'running';
    } catch (error) {
      this.currentState = 'failed';
      this.recordLifecycleDiagnostic('startup', error);
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
        // Startup cooperative cancellation settled and already cleaned up.
      }
    }

    if (this.activeRunPromise) {
      this.stop('destroy');
      try {
        await this.activeRunPromise;
      } catch {
        // Runtime failure remains primary failure.
      }
    } else if (this.currentState === 'running') {
      this.stop('destroy');
    }

    if (this.currentState !== 'failed' && this.currentState !== 'destroyed') {
      this.stopReason =
        this.currentState === 'created' ? 'destroyed-before-startup' : this.stopReason;
    }

    await this.shutdownBuiltPlugins(this.stopReason);
    await this.disposeAndRemoveContributions();
    this.pendingPlugins.length = 0;
    this.world.destroy();
    this.currentState = 'destroyed';
    return Object.freeze({ diagnostics: Object.freeze([...this.diagnostics]) });
  }

  private createReadonlyContext(): ReadonlyAppContext {
    const app = this;
    return Object.freeze({
      get state(): AppState {
        return app.state;
      },
      getResource<T>(token: ResourceToken<T>): T | undefined {
        return app.getResource(token);
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
    if (
      this.currentState === 'created' ||
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
      frame(timestampSeconds: number): FrameOutcome {
        return app.executeFrame(timestampSeconds);
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
      this.recordLifecycleDiagnostic('runtime', error);
      throw error;
    } finally {
      if (this.activeRunner === runner) {
        this.activeRunner = undefined;
      }
    }
  }

  private executeFrame(timestampSeconds: number): FrameOutcome {
    const frameHost: FrameHost = {
      world: this.world,
      schedules: this.schedules,
      services: this.services,
      telemetry: this.telemetry,
      recordLifecycleDiagnostic: (phase, err) => this.recordLifecycleDiagnostic(phase, err)
    };
    const outcome = executeEngineFrame(frameHost, timestampSeconds, this.frameCount);
    this.frameCount = outcome.frame;
    return outcome;
  }

  private createShutdownContext(pluginId: string, reason: string): ShutdownContext {
    return Object.freeze({
      ...this.createReadonlyContext(),
      pluginId,
      reason
    });
  }

  private async shutdownBuiltPlugins(reason: string): Promise<void> {
    for (const plugin of [...this.builtPlugins].reverse()) {
      const t0 = this.telemetry.now();
      this.telemetry.recordPluginStart(plugin.id, 'shutdown');
      try {
        await plugin.shutdown?.(this.createShutdownContext(plugin.id, reason));
        this.telemetry.recordPluginComplete(plugin.id, 'shutdown', this.telemetry.now() - t0);
      } catch (error) {
        this.telemetry.recordPluginFail(plugin.id, 'shutdown', this.telemetry.now() - t0, error);
        this.recordLifecycleDiagnostic('shutdown', error, plugin.id);
      }
    }
    this.builtPlugins.length = 0;
  }

  private async disposeAndRemoveContributions(): Promise<void> {
    for (const error of await this.services.disposeAll()) {
      this.recordLifecycleDiagnostic('service-disposal', error);
    }
    for (const error of removeRegistrations(this.registrations)) {
      this.recordLifecycleDiagnostic('contribution-cleanup', error);
    }
    this.registrations.length = 0;
    this.services.clearRegistrations();
    this.extensions.clear();
  }

  private assertCreated(operation: string): void {
    if (this.destroyPromise) {
      throw new Error(
        this.currentState === 'destroyed'
          ? `Cannot ${operation} while App is in state "destroyed".`
          : `Cannot ${operation} while App is being destroyed.`
      );
    }
    if (this.currentState !== 'created') {
      throw new Error(`Cannot ${operation} while App is in state "${this.currentState}".`);
    }
  }

  private recordLifecycleDiagnostic(
    phase: LifecycleDiagnostic['phase'],
    error: unknown,
    pluginId?: string
  ): void {
    const diagnostic = createLifecycleDiagnostic(phase, error, pluginId);
    this.diagnostics.push(diagnostic);
    this.world.getResource(DiagnosticStoreResource)?.emit({
      code: diagnostic.code,
      severity: 'error',
      message: error instanceof Error ? error.message : `App ${phase} failed.`,
      subsystem: 'app',
      context: pluginId === undefined ? { phase } : { phase, pluginId },
      cause: error
    });
  }
}

function createOwnedPluginRecord(plugin: Plugin): Plugin {
  if (typeof plugin.id !== 'string' || plugin.id.trim() === '') {
    throw new Error('Plugin id must not be empty.');
  }
  return Object.freeze({
    id: plugin.id,
    dependencies: plugin.dependencies ? Object.freeze([...plugin.dependencies]) : undefined,
    build: plugin.build.bind(plugin),
    prepare: plugin.prepare ? plugin.prepare.bind(plugin) : undefined,
    finish: plugin.finish ? plugin.finish.bind(plugin) : undefined,
    shutdown: plugin.shutdown ? plugin.shutdown.bind(plugin) : undefined
  });
}

import { World } from '../ecs/world';
import type { ResourceType } from '../ecs/types';
import { ExtensionRegistry, ServiceRegistry } from './registry';
import { Schedule } from './schedule';
import type { ScheduleLabel, System, SystemDescriptor, Plugin, PluginGroup } from './types';
import { DEFAULT_SCHEDULES, STARTUP_SCHEDULES, FRAME_SCHEDULES } from './constants';

/**
 * Entry point of AetherEngine. Manages plugin lifecycles, schedules, 
 * global/scoped service dependency registries, and the rendering/tick loop.
 */
export class App {
  // Service dependency injection and extensibility registries.
  readonly services = new ServiceRegistry();
  readonly extensions = new ExtensionRegistry();

  private readonly world = new World();
  private readonly schedules = new Map<ScheduleLabel, Schedule>();
  private readonly plugins = new Map<string, Plugin>();
  
  // Accumulated plugins waiting to be sorted and built at startup.
  private readonly pendingPlugins = new Map<string, Plugin>();
  
  // Tracked plugin build sequence to perform cleanup in reverse topological order.
  private readonly pluginBuildOrder: Plugin[] = [];
  private isRunning = false;
  private hasStarted = false;

  constructor() {
    for (const schedule of DEFAULT_SCHEDULES) {
      this.addSchedule(schedule);
    }
  }

  /**
   * Immediately builds and installs a plugin. Requires all dependencies 
   * to already be installed. Use registerPlugin() for deferred topological ordering.
   */
  addPlugin(plugin: Plugin): this {
    if (this.plugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" already added, skipping.`);
      return this;
    }

    this.pendingPlugins.delete(plugin.name);

    for (const dependency of plugin.dependencies ?? []) {
      if (!this.plugins.has(dependency)) {
        throw new Error(`Plugin "${plugin.name}" requires "${dependency}" to be registered.`);
      }
    }

    plugin.build(this);
    this.plugins.set(plugin.name, plugin);
    this.pluginBuildOrder.push(plugin);
    return this;
  }

  /**
   * Sorts the provided batch of plugins topologically and installs them immediately.
   */
  addPlugins(plugins: Plugin[] | PluginGroup): this {
    const list = Array.isArray(plugins) ? plugins : plugins.plugins();
    for (const plugin of this.sortPlugins(list)) {
      this.installPlugin(plugin);
    }
    return this;
  }

  /**
   * Registers a plugin for deferred installation. Its build() method 
   * will be triggered during startup() after topological sorting.
   */
  registerPlugin(plugin: Plugin): this {
    if (this.plugins.has(plugin.name) || this.pendingPlugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" already added, skipping.`);
      return this;
    }

    this.pendingPlugins.set(plugin.name, plugin);
    return this;
  }

  /**
   * Registers a batch of plugins for deferred topological installation.
   */
  registerPlugins(plugins: Plugin[] | PluginGroup): this {
    const list = Array.isArray(plugins) ? plugins : plugins.plugins();
    for (const plugin of list) {
      this.registerPlugin(plugin);
    }
    return this;
  }

  /**
   * Sorts and builds all pending deferred plugins topologically.
   */
  buildPlugins(): this {
    for (const pluginName of this.pendingPlugins.keys()) {
      if (this.plugins.has(pluginName)) {
        this.pendingPlugins.delete(pluginName);
      }
    }

    if (this.pendingPlugins.size === 0) {
      return this;
    }

    const sorted = this.sortPlugins([...this.pendingPlugins.values()]);
    for (const plugin of sorted) {
      this.installPlugin(plugin);
      this.pendingPlugins.delete(plugin.name);
    }
    return this;
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  addSchedule(label: ScheduleLabel): this {
    if (!this.schedules.has(label)) {
      this.schedules.set(label, new Schedule(label));
    }
    return this;
  }

  getSchedule(label: ScheduleLabel): Schedule | undefined {
    return this.schedules.get(label);
  }

  addSystem(stage: ScheduleLabel, system: SystemDescriptor | System): this {
    const schedule = this.schedules.get(stage);
    if (!schedule) {
      throw new Error(`Schedule "${stage}" not found.`);
    }

    schedule.addSystem(system);
    return this;
  }

  addSystems(stage: ScheduleLabel, systems: Array<SystemDescriptor | System>): this {
    for (const system of systems) {
      this.addSystem(stage, system);
    }
    return this;
  }

  insertResource<T extends object>(resource: T): this {
    this.world.insertResource(resource);
    return this;
  }

  getResource<T>(type: ResourceType<T>): T | undefined {
    return this.world.getResource(type);
  }

  getWorld(): World {
    return this.world;
  }

  /**
   * Prepares and initializes the application. Builds deferred plugins 
   * and runs PreStartup, Startup, and PostStartup stages.
   * Asynchronous to allow for async systems (e.g. GPU device negotiation or asset loads).
   */
  async startup(): Promise<void> {
    if (this.hasStarted) {
      return;
    }

    this.buildPlugins();

    for (const label of STARTUP_SCHEDULES) {
      await this.runSchedule(label);
    }
    this.hasStarted = true;
  }

  /**
   * Executes a single tick update synchronously.
   * Runs all update/render stages, clears single-frame cached services and ECS trackers.
   * Strictly synchronous to prevent Promise allocation overhead in the main loop.
   */
  runFrame(): void {
    for (const label of FRAME_SCHEDULES) {
      this.runScheduleSync(label);
    }
    this.services.clearFrameScoped();
    this.world.clearTrackers();
  }

  /**
   * Starts the main animation loop. Auto-negotiates environments that 
   * support requestAnimationFrame, falling back to a single tick execution.
   */
  async run(): Promise<void> {
    if (this.isRunning) {
      throw new Error('App is already running.');
    }

    this.isRunning = true;
    await this.startup();

    const requestFrame = globalThis.requestAnimationFrame;
    if (!requestFrame) {
      this.runFrame();
      this.stop();
      return;
    }

    // Loop callback with strict try-catch to stop the loop on system error,
    // avoiding phantom raf cycles.
    const loop = (): void => {
      if (!this.isRunning) {
        return;
      }

      try {
        this.runFrame();
      } catch (error) {
        this.stop();
        throw error;
      }

      requestFrame(loop);
    };

    requestFrame(loop);
  }

  stop(): void {
    this.isRunning = false;
  }

  /**
   * Tears down the application. Cleans up plugins in reverse build order, 
   * and clears service and extension contribution registries.
   */
  destroy(): void {
    this.stop();

    // Cleanup in reverse dependency build sequence.
    for (const plugin of [...this.pluginBuildOrder].reverse()) {
      plugin.cleanup?.(this);
    }

    this.services.clear();
    this.extensions.clear();
    this.pluginBuildOrder.length = 0;
    this.plugins.clear();
    this.pendingPlugins.clear();
    this.hasStarted = false;
  }

  private async runSchedule(label: ScheduleLabel): Promise<void> {
    await this.schedules.get(label)?.run(this.world);
  }

  private runScheduleSync(label: ScheduleLabel): void {
    this.schedules.get(label)?.runSync(this.world, 'frame');
  }

  private installPlugin(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" already added, skipping.`);
      return;
    }

    this.pendingPlugins.delete(plugin.name);
    plugin.build(this);
    this.plugins.set(plugin.name, plugin);
    this.pluginBuildOrder.push(plugin);
  }

  /**
   * Sorts plugins topologically based on dependencies using Depth-First Search.
   * Throws on cyclic dependencies.
   */
  private sortPlugins(plugins: Plugin[]): Plugin[] {
    const candidates = new Map<string, Plugin>();
    for (const plugin of plugins) {
      if (!this.plugins.has(plugin.name) && !candidates.has(plugin.name)) {
        candidates.set(plugin.name, plugin);
      }
    }

    const temporary = new Set<string>();
    const permanent = new Set<string>();
    const sorted: Plugin[] = [];

    const visit = (plugin: Plugin): void => {
      if (this.plugins.has(plugin.name) || permanent.has(plugin.name)) {
        return;
      }
      if (temporary.has(plugin.name)) {
        throw new Error('Circular plugin dependency detected.');
      }

      temporary.add(plugin.name);
      for (const dependencyName of plugin.dependencies ?? []) {
        if (this.plugins.has(dependencyName)) {
          continue;
        }

        const dependency = candidates.get(dependencyName);
        if (!dependency) {
          throw new Error(`Plugin "${plugin.name}" requires "${dependencyName}" to be registered.`);
        }

        visit(dependency);
      }
      temporary.delete(plugin.name);
      permanent.add(plugin.name);
      sorted.push(plugin);
    };

    for (const plugin of candidates.values()) {
      visit(plugin);
    }

    return sorted;
  }
}

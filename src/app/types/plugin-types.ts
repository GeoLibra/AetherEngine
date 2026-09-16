import type { ObserverDescriptor } from '../../ecs/observer';
import type { ResourceToken } from '../../ecs/types';
import type { EventChannel } from '../../events/event-channel';
import type { StateStore } from '../../events/state-store';
import type { SchemaMigration, TypeSchema } from '../../schema/types';
import type { AppState } from './lifecycle-types';
import type {
  AppScope,
  ExtensionContribution,
  ExtensionPoint,
  ExtensionSnapshot,
  ServiceRegistration,
  ServiceToken
} from './registry-types';
import type {
  CommandApplyPointDescriptor,
  ScheduleLabel,
  SystemDescriptor,
  SystemSetDescriptor
} from './schedule-types';

export interface AppBuilder {
  addSystem(stage: ScheduleLabel, descriptor: SystemDescriptor): void;
  addSystemSet(stage: ScheduleLabel, descriptor: SystemSetDescriptor): void;
  addCommandApplyPoint(stage: ScheduleLabel, descriptor: CommandApplyPointDescriptor): void;
  insertResource<T>(token: ResourceToken<T>, resource: T): void;
  replaceResource<T>(token: ResourceToken<T>, resource: T): void;
  provideService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void;
  replaceService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void;
  addExtension<T>(point: ExtensionPoint<T>, contribution: ExtensionContribution<T>): void;
  registerSchema<T>(schema: TypeSchema<T>): void;
  registerSchemaMigration(migration: SchemaMigration): void;
  addObserver<TView extends object>(descriptor: ObserverDescriptor<TView>): void;
  addEventChannel<T>(id: string, channel: EventChannel<T>): void;
  addStateStore<S>(id: string, store: StateStore<S>): void;
  /** Registers a synchronous cleanup callback invoked on rollback or final contribution disposal. */
  deferCleanup(dispose: () => void): void;
}

export interface ReadonlyAppContext {
  readonly state: AppState;
  getResource<T>(token: ResourceToken<T>): T | undefined;
  getService<T>(token: ServiceToken<T>, scope?: AppScope): T;
  listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[];
}

export interface PluginPrepareContext extends ReadonlyAppContext {
  readonly pluginId: string;
  readonly signal: AbortSignal;
}

export interface PluginFinishContext extends AppBuilder, ReadonlyAppContext {
  readonly pluginId: string;
}

export interface ShutdownContext extends ReadonlyAppContext {
  readonly pluginId: string;
  readonly reason: string;
}

export interface Plugin {
  readonly id: string;
  readonly dependencies?: readonly string[] | undefined;
  build(context: AppBuilder): void;
  prepare?: ((context: PluginPrepareContext) => void | Promise<void>) | undefined;
  finish?: ((context: PluginFinishContext) => void) | undefined;
  shutdown?: ((context: ShutdownContext) => void | Promise<void>) | undefined;
}

export interface PluginGroup {
  plugins(): readonly Plugin[];
}

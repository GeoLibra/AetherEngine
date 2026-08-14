import type { World } from '../ecs/world';
import type { ComponentType, RelationType, ResourceToken } from '../ecs/types';
import type { SchemaMigration, TypeSchema } from '../schema';
import type { ObserverDescriptor } from '../ecs/observer';
import type { EventChannel } from '../events/event-channel';
import type { StateStore } from '../events/state-store';
import type { CoreSchedule, LifecycleDiagnosticCode } from './constants';

export type { CoreSchedule, LifecycleDiagnosticCode } from './constants';

// Registry scopes and token types
export type AppScope = 'main' | 'render' | 'editor' | 'asset-worker' | 'global';
export type ServiceToken<T> = symbol & { readonly __type?: T };
export type ExtensionPoint<T> = symbol & { readonly __extensionType?: T };

export type ServiceLifecycle = 'singleton' | 'frame' | 'transient';

export interface ServiceOptions<T> {
  readonly scope?: AppScope;
  readonly lifecycle?: ServiceLifecycle;
  readonly dispose?: (value: T) => void | Promise<void>;
}

export interface ServiceResolver {
  get<T>(token: ServiceToken<T>, scope?: AppScope): T;
  tryGet<T>(token: ServiceToken<T>, scope?: AppScope): T | undefined;
}

export interface ServiceValueRegistration<T> {
  readonly kind: 'value';
  readonly value: T;
  readonly options: Readonly<ServiceOptions<T>>;
}

export interface ServiceFactoryRegistration<T> {
  readonly kind: 'factory';
  readonly create: (services: ServiceResolver) => T;
  readonly options: Readonly<ServiceOptions<T>>;
}

export type ServiceRegistration<T> = ServiceValueRegistration<T> | ServiceFactoryRegistration<T>;

export interface RegistrationHandle {
  remove(): boolean;
}

export interface ExtensionContribution<T> {
  readonly id: string;
  readonly priority?: number;
  readonly value: T;
}

export interface ExtensionSnapshot<T> {
  readonly id: string;
  readonly priority: number;
  readonly ownerPlugin: string;
  readonly value: T;
}

// Schedule and system types
export type ScheduleLabel = CoreSchedule | (string & {});

export type System = (world: World) => void | Promise<void>;

export type AccessToken = ComponentType<object> | RelationType | ResourceToken<unknown>;

export interface SystemDescriptor {
  readonly id: string;
  readonly run: System;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly optionalBefore?: readonly string[];
  readonly optionalAfter?: readonly string[];
  readonly reads?: readonly AccessToken[];
  readonly writes?: readonly AccessToken[];
  readonly runIf?: (world: World) => boolean;
}

export interface SystemRegistration {
  readonly schedule: ScheduleLabel;
  readonly id: string;
}

export interface CommandApplyPointDescriptor {
  readonly id: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly optionalBefore?: readonly string[];
  readonly optionalAfter?: readonly string[];
}

export type AppState =
  | 'created'
  | 'building'
  | 'waiting-ready'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'destroyed';

export interface AppBuilder {
  addSystem(stage: ScheduleLabel, descriptor: SystemDescriptor): void;
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
}

export interface ReadonlyAppContext {
  readonly state: AppState;
  getResource<T>(token: ResourceToken<T>): T | undefined;
  getService<T>(token: ServiceToken<T>, scope?: AppScope): T;
  listExtensions<T>(point: ExtensionPoint<T>): readonly ExtensionSnapshot<T>[];
}

export interface ShutdownContext extends ReadonlyAppContext {
  readonly pluginId: string;
  readonly reason: string;
}

export interface Plugin {
  readonly id: string;
  readonly dependencies?: readonly string[];
  build(app: AppBuilder): void;
  ready?(app: ReadonlyAppContext): boolean | Promise<boolean>;
  finish?(app: AppBuilder): void | Promise<void>;
  shutdown?(app: ShutdownContext): void | Promise<void>;
}

export interface PluginGroup {
  plugins(): readonly Plugin[];
}

export interface LifecycleDiagnostic {
  readonly code: LifecycleDiagnosticCode;
  readonly phase:
    | 'startup'
    | 'runtime'
    | 'shutdown'
    | 'frame-cleanup'
    | 'service-disposal'
    | 'contribution-cleanup';
  readonly pluginId?: string;
  readonly error: unknown;
}

export interface DestroyResult {
  readonly diagnostics: readonly LifecycleDiagnostic[];
}

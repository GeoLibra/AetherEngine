import type { World } from '../ecs/world';
import type { ResourceType } from '../ecs/types';
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

export type ServiceRegistration<T> =
  | ServiceValueRegistration<T>
  | ServiceFactoryRegistration<T>;

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
export type ScheduleLabel =
  | 'PreStartup'
  | 'Startup'
  | 'PostStartup'
  | 'First'
  | 'PreUpdate'
  | 'Update'
  | 'PostUpdate'
  | 'Last'
  | 'PreRender'
  | 'Render'
  | 'PostRender'
  | string;

export type System = (world: World) => void | Promise<void>;

export interface SystemDescriptor {
  readonly id: string;
  readonly run: System;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly optionalBefore?: readonly string[];
  readonly optionalAfter?: readonly string[];
  readonly runIf?: (world: World) => boolean;
}

export interface SystemRegistration {
  readonly schedule: ScheduleLabel;
  readonly id: string;
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
  insertResource<T extends object>(resource: T): void;
  replaceResource<T extends object>(resource: T): void;
  provideService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void;
  replaceService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void;
  addExtension<T>(point: ExtensionPoint<T>, contribution: ExtensionContribution<T>): void;
}

export interface ReadonlyAppContext {
  readonly state: AppState;
  getResource<T extends object>(type: ResourceType<T>): T | undefined;
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
  readonly code:
    | 'APP_STARTUP_FAILED'
    | 'APP_RUNTIME_FAILED'
    | 'PLUGIN_SHUTDOWN_FAILED'
    | 'FRAME_CLEANUP_FAILED'
    | 'SERVICE_DISPOSAL_FAILED'
    | 'CONTRIBUTION_CLEANUP_FAILED';
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

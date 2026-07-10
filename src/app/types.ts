import type { World } from '../ecs/world';
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

// Plugin system interfaces
export interface Plugin {
  readonly name: string;
  readonly dependencies?: string[];
  build(app: any): void; // Use any to avoid circular import issues with App
  cleanup?(app: any): void;
}

export interface PluginGroup {
  plugins(): Plugin[];
}

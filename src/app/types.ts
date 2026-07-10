import type { World } from '../ecs/world';
import type { ServiceRegistry } from './registry';

// Registry scopes and token types
export type AppScope = 'main' | 'render' | 'editor' | 'asset-worker' | 'global';
export type ServiceToken<T> = symbol & { readonly __type?: T };
export type ExtensionPoint<T> = symbol & { readonly __extensionType?: T };

export interface ServiceOptions {
  scope?: AppScope;
  lifecycle?: 'singleton' | 'frame' | 'transient';
  debugName?: string;
}

export type ServiceProvider<T> = T | ((registry: ServiceRegistry) => T);

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

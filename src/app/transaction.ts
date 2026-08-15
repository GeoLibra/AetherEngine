import type { ResourceToken } from '../ecs/types';
import type { World } from '../ecs/world';
import { SchemaRegistry, SchemaRegistryResource } from '../schema';
import type { SchemaMigration, TypeSchema } from '../schema/types';
import type { ObserverDescriptor } from '../ecs/observer';
import { CommandBufferResource } from '../ecs/command-buffer';
import { EventRegistryResource } from '../events/event-registry';
import type { EventChannel } from '../events/event-channel';
import { StateRegistryResource } from '../events/state-registry';
import type { StateStore } from '../events/state-store';
import type { ExtensionRegistry, ServiceRegistry } from './registry';
import type { Schedule } from './schedule';
import type {
  AppBuilder,
  CommandApplyPointDescriptor,
  ExtensionContribution,
  ExtensionPoint,
  RegistrationHandle,
  ScheduleLabel,
  ServiceRegistration,
  ServiceToken,
  SystemDescriptor
} from './types';

export interface RegistrationTransactionHost {
  readonly world: World;
  readonly schedules: ReadonlyMap<ScheduleLabel, Schedule>;
  readonly services: ServiceRegistry;
  readonly extensions: ExtensionRegistry;
}

/** Applies structural changes immediately while retaining exact reverse operations. */
export class RegistrationTransaction implements AppBuilder {
  private readonly handles: RegistrationHandle[] = [];
  private closed = false;

  constructor(
    private readonly host: RegistrationTransactionHost,
    private readonly ownerPlugin: string
  ) {}

  addSystem(stage: ScheduleLabel, descriptor: SystemDescriptor): void {
    this.assertOpen();
    const schedule = this.host.schedules.get(stage);
    if (!schedule) {
      throw new Error(`Schedule "${stage}" not found.`);
    }
    const registration = schedule.addSystem(descriptor);
    this.handles.push(createHandle(() => schedule.removeSystem(registration)));
  }

  addCommandApplyPoint(stage: ScheduleLabel, descriptor: CommandApplyPointDescriptor): void {
    this.assertOpen();
    if (descriptor.id.trim() === '') {
      throw new Error('Command apply point id must not be empty.');
    }
    this.addSystem(stage, {
      ...descriptor,
      id: `aether.command-apply:${descriptor.id}`,
      run(world) {
        const commands = world.getResource(CommandBufferResource);
        if (commands && commands.length > 0) {
          commands.apply(world, `named:${descriptor.id}`);
        }
      }
    });
  }

  insertResource<T>(token: ResourceToken<T>, resource: T): void {
    this.assertOpen();
    if (this.host.world.hasResource(token)) {
      throw new Error(`Resource "${token.debugName}" is already registered.`);
    }
    this.host.world.insertResource(token, resource);
    this.handles.push(
      createHandle(() => {
        if (this.host.world.getResource(token) !== resource) {
          return false;
        }
        this.host.world.removeResource(token);
        return true;
      })
    );
  }

  replaceResource<T>(token: ResourceToken<T>, resource: T): void {
    this.assertOpen();
    const previous = this.host.world.replaceResource(token, resource);
    this.handles.push(
      createHandle(() => {
        if (this.host.world.getResource(token) !== resource) {
          return false;
        }
        this.host.world.replaceResource(token, previous);
        return true;
      })
    );
  }

  provideService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void {
    this.assertOpen();
    this.handles.push(this.host.services.provide(token, registration));
  }

  replaceService<T>(token: ServiceToken<T>, registration: ServiceRegistration<T>): void {
    this.assertOpen();
    this.handles.push(this.host.services.replace(token, registration));
  }

  addExtension<T>(point: ExtensionPoint<T>, contribution: ExtensionContribution<T>): void {
    this.assertOpen();
    this.handles.push(this.host.extensions.add(point, this.ownerPlugin, contribution));
  }

  registerSchema<T>(schema: TypeSchema<T>): void {
    this.assertOpen();
    this.handles.push(this.getSchemaRegistry().register(schema));
  }

  registerSchemaMigration(migration: SchemaMigration): void {
    this.assertOpen();
    this.handles.push(this.getSchemaRegistry().registerMigration(migration));
  }

  addObserver<TView extends object>(descriptor: ObserverDescriptor<TView>): void {
    this.assertOpen();
    this.handles.push(this.host.world.addObserver(descriptor));
  }

  addEventChannel<T>(id: string, channel: EventChannel<T>): void {
    this.assertOpen();
    const registry = this.host.world.getResource(EventRegistryResource);
    if (!registry) {
      throw new Error('World EventRegistry is not available.');
    }
    this.handles.push(registry.add(id, channel));
  }

  addStateStore<S>(id: string, store: StateStore<S>): void {
    this.assertOpen();
    const registry = this.host.world.getResource(StateRegistryResource);
    if (!registry) {
      throw new Error('World StateRegistry is not available.');
    }
    this.handles.push(registry.add(id, store));
  }

  commit(): readonly RegistrationHandle[] {
    this.assertOpen();
    this.closed = true;
    return Object.freeze([...this.handles]);
  }

  rollback(): void {
    this.assertOpen();
    this.closed = true;
    const errors = removeAll(this.handles);
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to roll back plugin "${this.ownerPlugin}".`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Registration transaction for plugin "${this.ownerPlugin}" is closed.`);
    }
  }

  private getSchemaRegistry(): SchemaRegistry {
    const registry = this.host.world.getResource(SchemaRegistryResource);
    if (!registry) {
      throw new Error('World SchemaRegistry is not available.');
    }
    return registry;
  }
}

export function removeRegistrations(handles: readonly RegistrationHandle[]): readonly unknown[] {
  return Object.freeze(removeAll(handles));
}

function removeAll(handles: readonly RegistrationHandle[]): unknown[] {
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {
    try {
      handle.remove();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function createHandle(remove: () => boolean): RegistrationHandle {
  let active = true;
  return {
    remove(): boolean {
      if (!active) {
        return false;
      }
      const removed = remove();
      if (removed) {
        active = false;
      }
      return removed;
    }
  };
}

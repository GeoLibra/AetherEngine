import type { ResourceType } from '../ecs/types';
import type { World } from '../ecs/world';
import { SchemaRegistry } from '../schema';
import type { SchemaMigration, TypeSchema } from '../schema';
import type { ExtensionRegistry, ServiceRegistry } from './registry';
import type { Schedule } from './schedule';
import type {
  AppBuilder,
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

  insertResource<T extends object>(resource: T): void {
    this.assertOpen();
    const type = resource.constructor as ResourceType<T>;
    if (this.host.world.hasResource(type)) {
      throw new Error(`Resource "${type.name}" is already registered.`);
    }
    this.host.world.insertResource(resource);
    this.handles.push(
      createHandle(() => {
        if (this.host.world.getResource(type) !== resource) {
          return false;
        }
        this.host.world.removeResource(type);
        return true;
      })
    );
  }

  replaceResource<T extends object>(resource: T): void {
    this.assertOpen();
    const type = resource.constructor as ResourceType<T>;
    const previous = this.host.world.getResource(type);
    if (!previous) {
      throw new Error(`Resource "${type.name}" is not registered.`);
    }
    this.host.world.insertResource(resource);
    this.handles.push(
      createHandle(() => {
        if (this.host.world.getResource(type) !== resource) {
          return false;
        }
        this.host.world.insertResource(previous);
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

  addExtension<T>(
    point: ExtensionPoint<T>,
    contribution: ExtensionContribution<T>
  ): void {
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
    const registry = this.host.world.getResource(SchemaRegistry);
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

import { CommandBuffer } from './command-buffer';
import type { ComponentType, Entity, RelationType } from './types';
import type { World } from './world';

export type ObserverEventKind =
  | 'component-added'
  | 'component-removed'
  | 'relation-added'
  | 'relation-removed'
  | 'entity-despawned';

export interface ObserverEvent {
  readonly kind: ObserverEventKind;
  readonly entity: Entity;
  readonly component?: ComponentType<object>;
  readonly relation?: RelationType;
  readonly target?: Entity;
}

export interface ObserverDescriptor<TView extends object = object> {
  readonly id: string;
  readonly event: ObserverEventKind;
  readonly component?: ComponentType<TView>;
  readonly relation?: RelationType;
  readonly priority?: number;
  run(event: ObserverEvent, world: DeferredWorld): void;
}

export interface ObserverRegistration {
  remove(): boolean;
}

export class DeferredWorld {
  readonly commands = new CommandBuffer();

  constructor(private readonly world: World) {}

  getComponent<TView extends object>(
    entity: Entity,
    component: ComponentType<TView>
  ): Readonly<TView> | null {
    return this.world.getComponent(entity, component);
  }

  isAlive(entity: Entity): boolean {
    return this.world.isAlive(entity);
  }
}

interface RegisteredObserver {
  readonly descriptor: ObserverDescriptor<object>;
  readonly order: number;
}

export class ObserverRegistry {
  private readonly observers = new Map<string, RegisteredObserver>();
  private nextOrder = 0;

  add<TView extends object>(descriptor: ObserverDescriptor<TView>): ObserverRegistration {
    if (descriptor.id.trim() === '') {
      throw new Error('Observer id must not be empty.');
    }
    if (this.observers.has(descriptor.id)) {
      throw new Error(`Observer "${descriptor.id}" is already registered.`);
    }
    const registered: RegisteredObserver = {
      descriptor: descriptor as unknown as ObserverDescriptor<object>,
      order: this.nextOrder++
    };
    this.observers.set(descriptor.id, registered);
    let active = true;
    return {
      remove: (): boolean => {
        if (!active || this.observers.get(descriptor.id) !== registered) {
          return false;
        }
        active = false;
        return this.observers.delete(descriptor.id);
      }
    };
  }

  dispatch(events: readonly ObserverEvent[], world: World): CommandBuffer {
    const deferred = new DeferredWorld(world);
    for (const event of events) {
      const matching = [...this.observers.values()]
        .filter(({ descriptor }) => matches(descriptor, event))
        .sort(compareObservers);
      for (const observer of matching) {
        observer.descriptor.run(event, deferred);
      }
    }
    return deferred.commands;
  }

  clear(): void {
    this.observers.clear();
    this.nextOrder = 0;
  }
}

function matches(descriptor: ObserverDescriptor<object>, event: ObserverEvent): boolean {
  return (
    descriptor.event === event.kind &&
    (descriptor.component === undefined || descriptor.component === event.component) &&
    (descriptor.relation === undefined || descriptor.relation === event.relation)
  );
}

function compareObservers(left: RegisteredObserver, right: RegisteredObserver): number {
  const priority = (right.descriptor.priority ?? 0) - (left.descriptor.priority ?? 0);
  if (priority !== 0) {
    return priority;
  }
  const id = left.descriptor.id.localeCompare(right.descriptor.id);
  return id !== 0 ? id : left.order - right.order;
}

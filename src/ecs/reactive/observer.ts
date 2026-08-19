/**
 * ECS Reactive Observers Architecture
 *
 * 1. Event Contracts:
 *    - ObserverEventKind: Supported lifecycle event kinds ('component-added', 'component-removed', 'relation-added', 'relation-removed', 'entity-despawned').
 *    - ObserverEvent: Event payload containing target entity, component, relation, and target entity references.
 *    - ObserverDescriptor: Observer registration configuration (unique ID, priority, target filter, and execution callback).
 *
 * 2. Safe Execution Context:
 *    - DeferredWorld: A restricted World proxy passed to observer callbacks, enabling safe read operations while collecting deferred structural commands without reentrancy.
 *
 * 3. Observer Registry & Dispatcher:
 *    - ObserverRegistry: Manages registered observers, handles priority-based sorting, event matching, and collects deferred commands for batch execution.
 */

import { CommandBuffer } from '../command/command-buffer';
import type { ComponentType, Entity, Relation, RelationType } from '../types';
import type { World } from '../world';
import { DeferredWorld } from '../world/deferred-world';

export { DeferredWorld };

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

interface StoredObserver {
  readonly descriptor: ObserverDescriptor<object>;
  readonly priority: number;
  readonly order: number;
}

export class ObserverRegistry {
  private readonly observers = new Map<string, StoredObserver>();
  private nextOrder = 0;

  add<TView extends object>(descriptor: ObserverDescriptor<TView>): ObserverRegistration {
    if (descriptor.id.trim() === '') {
      throw new Error('Observer id must not be empty.');
    }
    if (this.observers.has(descriptor.id)) {
      throw new Error(`Observer "${descriptor.id}" is already registered.`);
    }

    const stored: StoredObserver = {
      descriptor: descriptor as unknown as ObserverDescriptor<object>,
      priority: descriptor.priority ?? 0,
      order: this.nextOrder++
    };
    this.observers.set(descriptor.id, stored);

    return {
      remove: () => this.observers.delete(descriptor.id)
    };
  }

  dispatch(events: readonly ObserverEvent[], world: World): CommandBuffer | undefined {
    if (events.length === 0 || this.observers.size === 0) {
      return undefined;
    }

    const matching = this.sortedObservers();
    const deferred = new DeferredWorld(world);

    for (const event of events) {
      for (const observer of matching) {
        if (!matchesEvent(observer.descriptor, event)) {
          continue;
        }
        observer.descriptor.run(event, deferred);
      }
    }

    return deferred.commands.length > 0 ? deferred.commands : undefined;
  }

  clear(): void {
    this.observers.clear();
    this.nextOrder = 0;
  }

  private sortedObservers(): readonly StoredObserver[] {
    return [...this.observers.values()].sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.order - right.order;
    });
  }
}

function matchesEvent(descriptor: ObserverDescriptor<object>, event: ObserverEvent): boolean {
  if (descriptor.event !== event.kind) {
    return false;
  }
  if (descriptor.component && descriptor.component.id !== event.component?.id) {
    return false;
  }
  if (descriptor.relation && descriptor.relation.id !== event.relation?.id) {
    return false;
  }
  return true;
}

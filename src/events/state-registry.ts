import { CommandBuffer } from '../ecs/command';
import { defineResource } from '../ecs/resource';
import type { StateStore, StateTransition } from './state-store';

export interface StateStoreRegistration {
  remove(): boolean;
}

export const StateRegistryResource = defineResource<StateRegistry>('aether.state-registry');

interface RegisteredStateStore {
  readonly pending: number;
  applyNext(commands?: CommandBuffer): StateTransition<unknown> | undefined;
}

export class StateRegistry {
  private readonly stores = new Map<string, RegisteredStateStore>();

  add<S>(id: string, store: StateStore<S>): StateStoreRegistration {
    if (id.trim() === '') {
      throw new Error('State store id must not be empty.');
    }
    if (this.stores.has(id)) {
      throw new Error(`State store "${id}" is already registered.`);
    }
    const registered = store as unknown as RegisteredStateStore;
    this.stores.set(id, registered);
    let active = true;
    return {
      remove: (): boolean => {
        if (!active || this.stores.get(id) !== registered) {
          return false;
        }
        active = false;
        return this.stores.delete(id);
      }
    };
  }

  applyPending(commands: CommandBuffer): readonly StateTransition<unknown>[] {
    const transitions: StateTransition<unknown>[] = [];
    for (const store of this.stores.values()) {
      if (store.pending === 0) {
        continue;
      }
      const localCommands = new CommandBuffer();
      const transition = store.applyNext(localCommands);
      if (transition) {
        commands.append(localCommands);
        transitions.push(transition);
      }
    }
    return Object.freeze(transitions);
  }
}

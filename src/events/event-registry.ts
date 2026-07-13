import type { EventChannel } from './event-channel';
import { defineResource } from '../ecs/resource';

export interface EventChannelRegistration {
  remove(): boolean;
}

export const EventRegistryResource = defineResource<EventRegistry>('aether.event-registry');

export class EventRegistry {
  private readonly channels = new Map<string, EventChannel<unknown>>();

  add<T>(id: string, channel: EventChannel<T>): EventChannelRegistration {
    if (id.trim() === '') {
      throw new Error('Event channel id must not be empty.');
    }
    if (this.channels.has(id)) {
      throw new Error(`Event channel "${id}" is already registered.`);
    }
    this.channels.set(id, channel as EventChannel<unknown>);
    let active = true;
    return {
      remove: (): boolean => {
        if (!active || this.channels.get(id) !== channel) {
          return false;
        }
        active = false;
        return this.channels.delete(id);
      }
    };
  }

  get<T>(id: string): EventChannel<T> | undefined {
    return this.channels.get(id) as EventChannel<T> | undefined;
  }

  advanceFrame(): void {
    for (const channel of this.channels.values()) {
      channel.advanceFrame();
    }
  }

  advanceFixedTick(): void {
    for (const channel of this.channels.values()) {
      channel.advanceFixedTick();
    }
  }
}

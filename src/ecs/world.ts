import type { ResourceType } from './types';

/**
 * ECS storage environment holding all game/engine resources.
 * Supports type-safe, constructor-keyed retrieval of unique resources.
 */
export class World {
  private readonly resources = new Map<ResourceType<unknown>, unknown>();

  insertResource<T extends object>(resource: T): this {
    // Uses the class constructor reference as the unique map key.
    // Safe from production-build name minification.
    this.resources.set(resource.constructor as ResourceType<T>, resource);
    return this;
  }

  getResource<T>(type: ResourceType<T>): T | undefined {
    return this.resources.get(type) as T | undefined;
  }

  hasResource<T>(type: ResourceType<T>): boolean {
    return this.resources.has(type);
  }

  removeResource<T>(type: ResourceType<T>): T | undefined {
    const resource = this.getResource(type);
    this.resources.delete(type);
    return resource;
  }

  clearTrackers(): void {
    // Change tracking is introduced by the ECS design; this stub keeps App lifecycle stable.
  }
}

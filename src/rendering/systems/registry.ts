import type { RegisteredRenderSystem, RenderSystemDescriptor, RenderSystemToken } from './types';

/** Asserts that an identifier string is non-empty. */
export function assertId(id: string, name: string): void {
  if (id.trim().length === 0) throw new Error(`${name} id must not be empty.`);
}

/** Validates that a render system descriptor has a valid ID and scope. */
export function validateDescriptor<TResources, TItem>(
  descriptor: RenderSystemDescriptor<TResources, TItem>
): void {
  assertId(descriptor.id, 'Render system');
  if (descriptor.scope !== 'global' && descriptor.scope !== 'per-view') {
    throw new Error(`Render system "${descriptor.id}" has an invalid scope.`);
  }
}

/** Creates a stable semantic token without creating a second scheduling domain. */
export function renderSystemToken(id: string): RenderSystemToken {
  assertId(id, 'Render system token');
  return Object.freeze({ kind: 'render-system', id });
}

/** Ordered authoring registry; compilation lowers every contribution into one RenderGraph. */
export class RenderSystemRegistry {
  private readonly systems: RegisteredRenderSystem[] = [];
  private readonly ids = new Set<string>();

  add<TResources, TItem>(descriptor: RenderSystemDescriptor<TResources, TItem>): RenderSystemToken {
    validateDescriptor(descriptor);
    if (this.ids.has(descriptor.id)) {
      throw new Error(`Render system id "${descriptor.id}" is already registered.`);
    }
    this.ids.add(descriptor.id);
    this.systems.push({
      descriptor: descriptor as unknown as RenderSystemDescriptor<unknown, unknown>,
      registrationIndex: this.systems.length
    });
    return renderSystemToken(descriptor.id);
  }

  entries(): readonly RegisteredRenderSystem[] {
    return Object.freeze([...this.systems]);
  }
}

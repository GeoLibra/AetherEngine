import type { RHIResource, RHIResourceKind, RHIResourceRef } from './types';

export abstract class NullResourceBase implements RHIResource {
  protected isReleased = false;
  abstract readonly kind: RHIResourceKind;
  readonly label: string | undefined;

  constructor(
    readonly id: number,
    readonly owner: symbol,
    label?: string
  ) {
    this.label = label;
  }

  get released(): boolean {
    return this.isReleased;
  }

  release(): void {
    if (this.isReleased) {
      throw new Error(`Resource "${this.label ?? this.kind}" has already been released.`);
    }
    this.isReleased = true;
  }
}

export function assertResourceLive(resource: RHIResource): void {
  if (resource.released) {
    throw new Error(`Resource "${resource.label ?? resource.kind}" has been released.`);
  }
}

export function assertResourceOwnedBy(resource: RHIResource, owner: symbol): void {
  if (!(resource instanceof NullResourceBase)) {
    const label =
      typeof resource === 'object' && resource !== null && 'label' in resource
        ? String(resource.label)
        : 'unknown';
    throw new Error(`Resource "${label}" was not created by NullDevice.`);
  }
  if (resource.owner !== owner) {
    throw new Error(`Resource "${resource.label ?? resource.kind}" belongs to a different NullDevice.`);
  }
}

export function toResourceRef(resource: RHIResource): RHIResourceRef {
  const ref: RHIResourceRef = {
    kind: resource.kind,
    id: resource.id
  };
  if (resource.label !== undefined) {
    ref.label = resource.label;
  }
  return ref;
}

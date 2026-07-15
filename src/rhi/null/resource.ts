import type { RHIResource, RHIResourceKind } from '../contracts';
import type { DeviceCapabilities } from '../contracts/capability';
import type { RHIDeviceState, RHIResourceState } from '../contracts/lifecycle';

export interface NullDeviceOwner {
  readonly token: symbol;
  readonly generation: number;
  readonly capabilities: DeviceCapabilities;
  state: RHIDeviceState;
}

export abstract class NullResourceBase implements RHIResource {
  protected isDisposed = false;
  abstract readonly kind: RHIResourceKind;
  readonly label: string | undefined;

  constructor(
    readonly id: number,
    readonly owner: NullDeviceOwner,
    label?: string
  ) {
    this.label = label;
  }

  get generation(): number {
    return this.owner.generation;
  }

  get state(): RHIResourceState {
    if (this.owner.state !== 'live') return 'device-lost';
    return this.isDisposed ? 'disposed' : 'live';
  }

  dispose(): void {
    this.isDisposed = true;
  }
}

export function assertResourceLive(resource: RHIResource): void {
  if (resource.state === 'disposed') {
    throw new Error(`Resource "${resource.label ?? resource.kind}" has been disposed.`);
  }
  if (resource.state === 'device-lost') {
    throw new Error(`Resource "${resource.label ?? resource.kind}" belongs to a lost device.`);
  }
}

export function assertResourceOwnedBy(resource: RHIResource, owner: NullDeviceOwner): void {
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

import type { DeviceCapabilities } from '../capability-types';
import type { RHIDeviceState } from '../lifecycle-types';
import type { WebGL2ResourceBase } from './resource';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './native-types';

export interface WebGL2DeviceOwner {
  readonly token: symbol;
  readonly generation: number;
  readonly capabilities: DeviceCapabilities;
  readonly native: WebGL2NativeContextPort;
  state: RHIDeviceState;
  allocateId(): number;
  subscribeResourceRelease(listener: (resource: WebGL2ResourceBase) => void): () => void;
  releaseResource(resource: WebGL2ResourceBase, handle: WebGL2NativeObject, owned: boolean): void;
}

import type { SurfaceTarget } from '../../platform/types';
import type { RHIDevice } from './device';
import type { RHITexture } from './resource';
import type { GPUTextureFormat } from './webgpu';

export interface RHISurfaceConfiguration {
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'display-p3' | 'hdr10';
  readonly alphaMode: 'opaque' | 'premultiplied';
  readonly width: number;
  readonly height: number;
  readonly presentMode: 'fifo' | 'mailbox' | 'immediate';
}

export type RHISurfaceState = 'unconfigured' | 'configured' | 'lost' | 'disposed';
export type RHISurfaceFrameState = 'acquired' | 'presented' | 'released';

export interface RHISurfaceFrame {
  readonly texture: RHITexture;
  readonly generation: number;
  readonly state: RHISurfaceFrameState;
  present(): void;
  release(): void;
}

export type RHISurfaceAcquireResult =
  | { readonly status: 'success'; readonly frame: RHISurfaceFrame }
  | {
      readonly status:
        'outdated' | 'timeout' | 'lost' | 'out-of-memory' | 'zero-extent' | 'device-lost';
    };

export interface RHISurface {
  readonly target: SurfaceTarget;
  readonly state: RHISurfaceState;
  readonly generation: number;
  readonly configuration: RHISurfaceConfiguration | undefined;
  configure(
    device: RHIDevice,
    configuration: RHISurfaceConfiguration,
    windowGeneration: number
  ): void;
  acquire(): RHISurfaceAcquireResult;
  dispose(): void;
}

import type { DeviceRequest, RHIAdapter } from '../../rhi/contracts/adapter';
import type { RHIDevice } from '../../rhi/contracts/device';
import type { RHISurface } from '../../rhi/contracts/surface';
import type { GPUTextureFormat } from '../../rhi/contracts/webgpu';
import type { BrowserWebGPUCanvas, BrowserWebGPUEnvironment } from '../../rhi/webgpu/browser';
import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';

export interface PhysicalSize {
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfaceOptions extends PhysicalSize {
  readonly format?: GPUTextureFormat;
  readonly colorSpace?: 'srgb' | 'display-p3';
  readonly alphaMode?: 'opaque' | 'premultiplied';
}

export interface BrowserGraphicsOptions {
  readonly canvas: BrowserWebGPUCanvas;
  readonly preference?: readonly ('webgpu' | 'webgl2')[];
  readonly powerPreference?: 'low-power' | 'high-performance';
  readonly device: DeviceRequest;
  readonly surface: BrowserSurfaceOptions;
  /** Test/embedding seam; production callers normally use the current global object. */
  readonly environment?: BrowserWebGPUEnvironment;
  readonly webgl2Translator?: WebGL2ShaderTranslationPort;
  readonly webgl2ClipControl?: boolean;
}

export interface BrowserGraphicsLoss {
  readonly backend: 'webgpu' | 'webgl2';
  readonly stage: 'device' | 'surface' | 'context';
  readonly reason: string;
  readonly generation: number;
  readonly recreationAllowed: boolean;
}

export interface BrowserGraphicsAttempt {
  readonly backend: 'webgpu' | 'webgl2';
  readonly stage: 'environment' | 'adapter' | 'device' | 'context' | 'surface';
  readonly classification: 'unavailable' | 'unsupported' | 'invalid' | 'failure';
  readonly message: string;
}

export interface BrowserGraphicsSession {
  readonly backend: 'webgpu' | 'webgl2';
  readonly adapter: RHIAdapter;
  readonly device: RHIDevice;
  readonly surface: RHISurface;
  readonly lost: Promise<BrowserGraphicsLoss>;
  resize(size: PhysicalSize): void;
  destroy(): Promise<void>;
}

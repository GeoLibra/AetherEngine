import type { GPUIndexFormat, GPUTextureAspect } from '../contracts/webgpu';
import type {
  RHIBindGroup,
  RHIBuffer,
  RHIResource,
  RHIRenderPipeline,
  RHITexture,
  RHITextureView
} from '../contracts/resource';

export interface WebGL2ImageCopyTexture {
  readonly texture: RHITexture;
  readonly mipLevel: number;
  readonly origin: Readonly<{ x: number; y: number; z: number }>;
  readonly aspect: GPUTextureAspect;
}

export interface WebGL2RenderPassSnapshot {
  readonly label?: string;
  readonly colorAttachments: readonly Readonly<{
    view: RHITextureView;
    resolveTarget?: RHITextureView;
    clearValue?: Readonly<{ r: number; g: number; b: number; a: number }>;
    loadOp: string;
    storeOp: string;
  }>[];
  readonly depthStencilAttachment?: Readonly<{
    view: RHITextureView;
    depthClearValue?: number;
    depthLoadOp?: string;
    depthStoreOp?: string;
    stencilClearValue?: number;
    stencilLoadOp?: string;
    stencilStoreOp?: string;
  }>;
}

export type WebGL2ReplayCommand =
  | Readonly<{ kind: 'begin-render-pass'; descriptor: WebGL2RenderPassSnapshot }>
  | Readonly<{ kind: 'end-render-pass'; label?: string }>
  | Readonly<{ kind: 'push-debug'; scope: 'encoder' | 'render-pass'; label: string }>
  | Readonly<{ kind: 'pop-debug'; scope: 'encoder' | 'render-pass' }>
  | Readonly<{ kind: 'set-pipeline'; pipeline: RHIRenderPipeline }>
  | Readonly<{ kind: 'set-bind-group'; index: number; group: RHIBindGroup; dynamicOffsets: readonly number[] }>
  | Readonly<{ kind: 'set-vertex-buffer'; slot: number; buffer: RHIBuffer; offset: number; size?: number }>
  | Readonly<{ kind: 'set-index-buffer'; buffer: RHIBuffer; indexFormat: GPUIndexFormat; offset: number; size?: number }>
  | Readonly<{ kind: 'set-viewport'; x: number; y: number; width: number; height: number; minDepth: number; maxDepth: number }>
  | Readonly<{ kind: 'set-scissor'; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: 'draw'; vertexCount: number; instanceCount: number; firstVertex: number; firstInstance: number }>
  | Readonly<{ kind: 'draw-indexed'; indexCount: number; instanceCount: number; firstIndex: number; baseVertex: number; firstInstance: number }>
  | Readonly<{
      kind: 'copy-buffer-to-buffer'; source: RHIBuffer; sourceOffset: number;
      destination: RHIBuffer; destinationOffset: number; size: number;
    }>
  | Readonly<{
      kind: 'copy-texture-to-texture'; source: WebGL2ImageCopyTexture;
      destination: WebGL2ImageCopyTexture;
      copySize: Readonly<{ width: number; height: number; depthOrArrayLayers: number }>;
    }>;

export type WebGL2LeasedResource = RHIResource;

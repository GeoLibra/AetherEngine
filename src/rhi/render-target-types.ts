import type { GPUColor, GPULoadOp, GPUStoreOp, GPUTextureFormat } from './webgpu-types';
import type { RHIResource, RHITexture, RHITextureView } from './resource-types';

export interface RenderTargetDescriptor {
  label?: string;
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  sampleCount?: number;
  colorAttachments: readonly ColorAttachmentDescriptor[];
  depthStencilAttachment?: DepthStencilAttachmentDescriptor;
}

export interface ColorAttachmentDescriptor {
  texture: RHITexture;
  view?: RHITextureView;
  format: GPUTextureFormat;
  mipLevel?: number;
  arrayLayer?: number;
  loadOp: GPULoadOp;
  storeOp: GPUStoreOp;
  clearValue?: GPUColor;
  resolveTarget?: RHITextureView;
}

export interface DepthStencilAttachmentDescriptor {
  texture: RHITexture;
  view?: RHITextureView;
  format: GPUTextureFormat;
  depthLoadOp?: GPULoadOp;
  depthStoreOp?: GPUStoreOp;
  depthClearValue?: number;
  stencilLoadOp?: GPULoadOp;
  stencilStoreOp?: GPUStoreOp;
  stencilClearValue?: number;
}

export interface RHIRenderTarget extends RHIResource {
  readonly kind: 'render-target';
  readonly descriptor: Readonly<RenderTargetDescriptor>;
  createRenderPassDescriptor(): RHIRenderPassDescriptor;
}

export interface RHIRenderPassColorAttachment {
  view: RHITextureView;
  resolveTarget?: RHITextureView;
  clearValue?: GPUColor;
  loadOp: GPULoadOp;
  storeOp: GPUStoreOp;
}

export interface RHIRenderPassDepthStencilAttachment {
  view: RHITextureView;
  depthClearValue?: number;
  depthLoadOp?: GPULoadOp;
  depthStoreOp?: GPUStoreOp;
  stencilClearValue?: number;
  stencilLoadOp?: GPULoadOp;
  stencilStoreOp?: GPUStoreOp;
}

export interface RHIRenderPassDescriptor {
  label?: string;
  colorAttachments: readonly RHIRenderPassColorAttachment[];
  depthStencilAttachment?: RHIRenderPassDepthStencilAttachment;
}

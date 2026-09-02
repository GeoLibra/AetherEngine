import type {
  GPUCommandBufferDescriptor,
  GPUComputePassDescriptor,
  GPUExtent3D,
  GPUIndexFormat,
  GPUTextureAspect
} from './webgpu';
import type {
  GPUImageCopyTexture,
  GPUImageCopyBuffer,
  RHIBindGroup,
  RHIBuffer,
  RHIComputePipeline,
  RHIResource,
  RHIResourceKind,
  RHIRenderPipeline
} from './resource';
import type { RHIRenderPassDescriptor } from './render-target';

export interface RHIDrawStats {
  drawCalls: number;
  indexedDrawCalls: number;
  indirectDrawCalls: number;
  instanceCount: number;
  vertexCount: number;
  indexCount: number;
  unknownVertexOrIndexCount: boolean;
  triangleCountEstimate: number;
}

export interface RHIComputeStats {
  dispatchWorkgroups: number;
  dispatchWorkgroupsIndirect: number;
}

export interface RHICopyStats {
  copyBufferToBuffer: number;
  copyTextureToTexture: number;
  copyBufferToTexture: number;
  copyTextureToBuffer: number;
}

export interface RHICommandStats {
  renderPasses: number;
  computePasses: number;
  draw: RHIDrawStats;
  compute: RHIComputeStats;
  copy: RHICopyStats;
}

export type RHICommandRecord =
  | { kind: 'beginRenderPass'; label?: string; colorAttachmentCount: number }
  | { kind: 'endRenderPass'; label?: string }
  | { kind: 'beginComputePass'; label?: string }
  | { kind: 'endComputePass'; label?: string }
  | { kind: 'pushDebugGroup'; scope: 'encoder' | 'render-pass' | 'compute-pass'; label: string }
  | { kind: 'popDebugGroup'; scope: 'encoder' | 'render-pass' | 'compute-pass' }
  | {
      kind: 'draw';
      vertexCount: number;
      instanceCount: number;
      firstVertex: number;
      firstInstance: number;
    }
  | {
      kind: 'drawIndexed';
      indexCount: number;
      instanceCount: number;
      firstIndex: number;
      baseVertex: number;
      firstInstance: number;
    }
  | { kind: 'drawIndirect'; buffer: RHIResourceRef; indirectOffset: number }
  | { kind: 'dispatchWorkgroups'; x: number; y: number; z: number }
  | { kind: 'dispatchWorkgroupsIndirect'; buffer: RHIResourceRef; indirectOffset: number }
  | {
      kind: 'setViewport';
      x: number;
      y: number;
      width: number;
      height: number;
      minDepth: number;
      maxDepth: number;
    }
  | { kind: 'setScissorRect'; x: number; y: number; width: number; height: number }
  | {
      kind: 'copyBufferToBuffer';
      source: RHIResourceRef;
      sourceOffset: number;
      destination: RHIResourceRef;
      destinationOffset: number;
      size: number;
    }
  | {
      kind: 'copyTextureToTexture';
      source: RHINormalizedImageCopyTexture;
      destination: RHINormalizedImageCopyTexture;
      copySize: RHINormalizedExtent3D;
    }
  | {
      kind: 'copyBufferToTexture';
      source: RHINormalizedImageCopyBuffer;
      destination: RHINormalizedImageCopyTexture;
      copySize: RHINormalizedExtent3D;
    }
  | {
      kind: 'copyTextureToBuffer';
      source: RHINormalizedImageCopyTexture;
      destination: RHINormalizedImageCopyBuffer;
      copySize: RHINormalizedExtent3D;
    }
  | {
      kind: 'setBindGroup';
      scope: 'render-pass' | 'compute-pass';
      index: number;
      bindGroup: RHIResourceRef;
      dynamicOffsets: readonly number[];
    }
  | { kind: 'setRenderPipeline'; pipeline: RHIResourceRef }
  | { kind: 'setComputePipeline'; pipeline: RHIResourceRef }
  | {
      kind: 'setIndexBuffer';
      buffer: RHIResourceRef;
      indexFormat: GPUIndexFormat;
      offset: number;
      size?: number;
    }
  | {
      kind: 'setVertexBuffer';
      slot: number;
      buffer: RHIResourceRef;
      offset: number;
      size?: number;
    };

export interface RHIResourceRef {
  kind: RHIResourceKind;
  id: number;
  label?: string;
}

export interface RHINormalizedOrigin3D {
  x: number;
  y: number;
  z: number;
}

export interface RHINormalizedExtent3D {
  width: number;
  height: number;
  depthOrArrayLayers: number;
}

export interface RHINormalizedImageCopyTexture {
  texture: RHIResourceRef;
  mipLevel: number;
  origin: RHINormalizedOrigin3D;
  aspect: GPUTextureAspect;
}

export interface RHINormalizedImageCopyBuffer {
  buffer: RHIResourceRef;
  offset: number;
  bytesPerRow: number;
  rowsPerImage: number;
}

export interface RHICommandBuffer extends RHIResource {
  readonly kind: 'command-buffer';
  getStats(): RHICommandStats;
  getCommandStream(): readonly RHICommandRecord[];
  toCommandStreamJSON(): string;
}

export interface RHICommandEncoder {
  beginRenderPass(descriptor: RHIRenderPassDescriptor): RHIRenderPassEncoder;
  beginComputePass(descriptor?: GPUComputePassDescriptor): RHIComputePassEncoder;
  pushDebugGroup(groupLabel: string): void;
  popDebugGroup(): void;
  copyBufferToBuffer(
    source: RHIBuffer,
    sourceOffset: number,
    destination: RHIBuffer,
    destinationOffset: number,
    size: number
  ): void;
  copyTextureToTexture(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyTexture,
    copySize: GPUExtent3D
  ): void;
  copyBufferToTexture(
    source: GPUImageCopyBuffer,
    destination: GPUImageCopyTexture,
    copySize: GPUExtent3D
  ): void;
  copyTextureToBuffer(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyBuffer,
    copySize: GPUExtent3D
  ): void;
  finish(descriptor?: GPUCommandBufferDescriptor): RHICommandBuffer;
  getStats(): RHICommandStats;
}

export interface RHIRenderPassEncoder {
  pushDebugGroup(groupLabel: string): void;
  popDebugGroup(): void;
  setPipeline(pipeline: RHIRenderPipeline): void;
  setBindGroup(index: number, bindGroup: RHIBindGroup, dynamicOffsets?: readonly number[]): void;
  setVertexBuffer(slot: number, buffer: RHIBuffer, offset?: number, size?: number): void;
  setIndexBuffer(
    buffer: RHIBuffer,
    indexFormat: GPUIndexFormat,
    offset?: number,
    size?: number
  ): void;
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number
  ): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void;
  drawIndirect(indirectBuffer: RHIBuffer, indirectOffset: number): void;
  end(): void;
}

export interface RHIComputePassEncoder {
  pushDebugGroup(groupLabel: string): void;
  popDebugGroup(): void;
  setPipeline(pipeline: RHIComputePipeline): void;
  setBindGroup(index: number, bindGroup: RHIBindGroup, dynamicOffsets?: readonly number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect(indirectBuffer: RHIBuffer, indirectOffset: number): void;
  end(): void;
}

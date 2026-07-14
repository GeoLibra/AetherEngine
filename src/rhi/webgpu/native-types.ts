import type { FormatCapabilities, RHIFeature, RHILimits } from '../capability-types';
import type { DiagnosticSource } from '../../diagnostics';
import type { RHISurfaceConfiguration } from '../surface-types';
import type { GPUTextureFormat } from '../webgpu-types';

export interface WebGPUNativeAdapterInfo {
  readonly name: string;
  readonly vendor?: string;
  readonly architecture?: string;
}

export interface WebGPUNativeDeviceRequest {
  readonly label?: string;
  readonly requiredFeatures: readonly string[];
  readonly requiredLimits: RHILimits;
}

export interface WebGPUNativeDeviceLostInfo {
  readonly reason?: string;
  readonly message?: string;
}

export type WebGPUNativeErrorType = 'validation' | 'out-of-memory' | 'internal' | 'unknown';

export interface WebGPUNativeErrorPort {
  readonly type: WebGPUNativeErrorType;
  readonly message: string;
  readonly source?: DiagnosticSource;
}

export interface WebGPUNativeResourcePort {
  destroy?(): void;
  mapAsync?(mode: number, offset: number, size: number): Promise<void>;
  getMappedRange?(offset: number, size: number): ArrayBuffer;
  unmap?(): void;
}

export interface WebGPUNativeBufferPort extends WebGPUNativeResourcePort {
  readonly size: number;
  readonly usage: number;
}

export interface WebGPUNativeTexturePort extends WebGPUNativeResourcePort {
  createView(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
}

export interface WebGPUNativeImportTexturePort extends WebGPUNativeTexturePort {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  readonly usage: number;
  readonly dimension: string;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
}

export interface WebGPUNativeRenderPassPort {
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  setPipeline(pipeline: WebGPUNativeResourcePort): void;
  setBindGroup(index: number, bindGroup: WebGPUNativeResourcePort, dynamicOffsets: readonly number[]): void;
  setVertexBuffer(slot: number, buffer: WebGPUNativeResourcePort, offset: number, size?: number): void;
  setIndexBuffer(buffer: WebGPUNativeResourcePort, format: string, offset: number, size?: number): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void;
  drawIndexed(indexCount: number, instanceCount: number, firstIndex: number, baseVertex: number, firstInstance: number): void;
  drawIndirect(buffer: WebGPUNativeResourcePort, offset: number): void;
  end(): void;
}

export interface WebGPUNativeComputePassPort {
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  setPipeline(pipeline: WebGPUNativeResourcePort): void;
  setBindGroup(index: number, bindGroup: WebGPUNativeResourcePort, dynamicOffsets: readonly number[]): void;
  dispatchWorkgroups(x: number, y: number, z: number): void;
  dispatchWorkgroupsIndirect(buffer: WebGPUNativeResourcePort, offset: number): void;
  end(): void;
}

export interface WebGPUNativeCommandEncoderPort {
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  beginRenderPass(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeRenderPassPort;
  beginComputePass(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeComputePassPort;
  copyBufferToBuffer(
    source: WebGPUNativeResourcePort,
    sourceOffset: number,
    destination: WebGPUNativeResourcePort,
    destinationOffset: number,
    size: number
  ): void;
  copyTextureToTexture(
    source: Readonly<Record<string, unknown>>,
    destination: Readonly<Record<string, unknown>>,
    copySize: Readonly<Record<string, number>>
  ): void;
  finish(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
}

export interface WebGPUNativeQueuePort {
  submit(commandBuffers: readonly WebGPUNativeResourcePort[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

export type WebGPUNativeSurfaceAcquireResult =
  | { readonly status: 'success'; readonly texture: WebGPUNativeTexturePort }
  | { readonly status: 'outdated' | 'timeout' | 'lost' | 'out-of-memory' };

export interface WebGPUNativeSurfaceConfiguration extends RHISurfaceConfiguration {
  readonly device: WebGPUNativeDevicePort;
}

export interface WebGPUNativeCanvasContextPort {
  configure(configuration: WebGPUNativeSurfaceConfiguration): void;
  getCurrentTexture(): WebGPUNativeSurfaceAcquireResult;
  present?(): void;
  unconfigure?(): void;
}

export interface WebGPUNativeDevicePort {
  readonly lost: Promise<WebGPUNativeDeviceLostInfo>;
  readonly queue: WebGPUNativeQueuePort;
  destroy?(): void;
  createBuffer?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createTexture?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeTexturePort;
  createSampler?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createShaderModule?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createBindGroupLayout?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createPipelineLayout?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createBindGroup?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createRenderPipeline?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createComputePipeline?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createRenderPipelineAsync?(descriptor: Readonly<Record<string, unknown>>): Promise<WebGPUNativeResourcePort>;
  createComputePipelineAsync?(descriptor: Readonly<Record<string, unknown>>): Promise<WebGPUNativeResourcePort>;
  createCommandEncoder?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeCommandEncoderPort;
  pushErrorScope?(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope?(): Promise<WebGPUNativeErrorPort | null>;
  setUncapturedErrorHandler?(handler: (error: WebGPUNativeErrorPort) => void): void | (() => void);
}

export interface WebGPUNativeAdapterPort {
  readonly info: WebGPUNativeAdapterInfo;
  readonly features: ReadonlySet<string>;
  readonly limits: RHILimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  requestDevice(request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort>;
}

export const WEBGPU_CORE_FEATURES: readonly RHIFeature[] = Object.freeze([
  'compute',
  'storage-buffer',
  'storage-texture',
  'indirect-draw'
]);

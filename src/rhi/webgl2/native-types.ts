import type { FormatCapabilities, RHILimits } from '../contracts/capability';
import type { GPUTextureFormat } from '../contracts/webgpu';
import type { WebGL2BindingManifestEntry } from './shader-types';

export type WebGL2NativeLimits = RHILimits;

export interface WebGL2NativeContextInfo {
  readonly name: string;
  readonly vendor?: string;
  readonly renderer?: string;
}

export interface WebGL2NativeContextLostInfo {
  readonly reason?: string;
  readonly message?: string;
}

export type WebGL2NativeObject = object;

export interface WebGL2FramebufferStatus {
  readonly complete: boolean;
  readonly status?: string;
}

export interface WebGL2NativeContextPort {
  readonly info: WebGL2NativeContextInfo;
  readonly extensions: ReadonlySet<string>;
  readonly limits: WebGL2NativeLimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  readonly precision: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGL2NativeContextLostInfo>;
  createBuffer?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createTexture?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createSampler?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createProgram?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  getProgramReflection?(program: WebGL2NativeObject): readonly WebGL2BindingManifestEntry[];
  deleteBuffer?(handle: WebGL2NativeObject): void;
  deleteTexture?(handle: WebGL2NativeObject): void;
  deleteSampler?(handle: WebGL2NativeObject): void;
  deleteProgram?(handle: WebGL2NativeObject): void;
  writeBuffer?(handle: WebGL2NativeObject, offset: number, data: ArrayBufferView): void;
  writeTexture?(
    destination: Readonly<Record<string, unknown>>,
    data: ArrayBufferView,
    dataLayout: Readonly<Record<string, number | undefined>>,
    size: Readonly<Record<string, number>>
  ): void;
  useProgram?(program: WebGL2NativeObject): void;
  beginRenderPass?(descriptor: Readonly<Record<string, unknown>>): void;
  endRenderPass?(): void;
  setRasterState?(state: Readonly<Record<string, unknown>>): void;
  setDepthStencilState?(state: Readonly<Record<string, unknown>>): void;
  setViewport?(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect?(x: number, y: number, width: number, height: number): void;
  bindVertexBuffer?(slot: number, buffer: WebGL2NativeObject, offset: number, size?: number): void;
  bindIndexBuffer?(buffer: WebGL2NativeObject, indexFormat: string, offset: number, size?: number): void;
  bindUniformBuffer?(binding: number, buffer: WebGL2NativeObject, offset: number, size: number): void;
  bindTexture?(unit: number, texture: WebGL2NativeObject): void;
  bindSampler?(unit: number, sampler: WebGL2NativeObject): void;
  draw?(vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void;
  drawIndexed?(indexCount: number, instanceCount: number, firstIndex: number, baseVertex: number, firstInstance: number): void;
  copyBufferToBuffer?(
    source: WebGL2NativeObject, sourceOffset: number,
    destination: WebGL2NativeObject, destinationOffset: number, size: number
  ): void;
  copyTextureToTexture?(
    source: Readonly<Record<string, unknown>>,
    destination: Readonly<Record<string, unknown>>,
    size: Readonly<Record<string, number>>
  ): void;
  pushDebugGroup?(label: string): void;
  popDebugGroup?(): void;
  createSubmissionFence?(): Promise<void>;
  createFramebuffer?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  checkFramebufferStatus?(framebuffer: WebGL2NativeObject): WebGL2FramebufferStatus;
  bindFramebuffer?(framebuffer: WebGL2NativeObject): void;
  deleteFramebuffer?(framebuffer: WebGL2NativeObject): void;
  applyRenderPassLoadOperations?(descriptor: Readonly<Record<string, unknown>>): void;
  applyRenderPassStoreOperations?(descriptor: Readonly<Record<string, unknown>>): void;
  resolveRenderPass?(descriptor: Readonly<Record<string, unknown>>): void;
  createVertexArray?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  bindVertexArray?(vertexArray: WebGL2NativeObject): void;
  deleteVertexArray?(vertexArray: WebGL2NativeObject): void;
  destroy?(): void;
}

export interface WebGL2AdapterFacts {
  readonly extensions: ReadonlySet<string>;
  readonly precision: Readonly<Record<string, number>>;
}

export { NullDevice } from './null/device';
export type { NullDeviceOptions } from './null/device';
export type { NullSubmissionMode } from './null/queue';
export { NullAdapter } from './null/adapter';
export { WebGPUAdapter } from './webgpu/adapter';
export { getBrowserWebGPUEnvironment } from './webgpu/browser';
export { requestBrowserWebGPUAdapter } from './webgpu/browser';
export type {
  BrowserGPUCanvasContext,
  BrowserWebGPU,
  BrowserWebGPUAdapterRequestOptions,
  BrowserWebGPUCanvas,
  BrowserWebGPUEnvironment,
  BrowserWebGPUGlobalObject
} from './webgpu/browser';
export { WebGL2Adapter } from './webgl2/adapter';
export {
  createBrowserWebGL2ContextPort,
  initializeWebGL2StateDefaults,
  WebGL2BrowserSurface
} from './webgl2/browser';
export {
  createCookedArtifactWebGL2Translator,
  createWebGL2TranslationRouter
} from './webgl2/shader';
export type {
  BuiltInShaderRegistration,
  CookedArtifactWebGL2TranslatorOptions,
  WebGL2RouterRegistrationEntry,
  WebGL2ShaderModuleRegistration,
  WebGL2ShaderRegistration,
  WebGL2ShaderRegistrationOverrides,
  WebGL2TranslationInput,
  WebGL2TranslationRouterOptions
} from './webgl2/shader';
export type { BrowserWebGL2Canvas, BrowserWebGL2ContextOptions } from './webgl2/browser';
export {
  NativeDawnAdapter,
  NativeDawnDeviceRequestError,
  createNativeDawnCapabilities
} from './native';
export type {
  NativeDawnAdapterFacts,
  NativeDawnAdapterPort,
  NativeDawnBackend,
  NativeDawnFactsPort
} from './native';
export { WebGL2ContextControlExtension } from './webgl2/context-control';
export { WebGL2ProgramCreationError } from './webgl2/errors';
export { WebGPUSurface } from './webgpu/surface';
export { WebGPUInteropExtension } from './webgpu/interop';
export type { NullAdapterOptions } from './null/adapter';
export { NullRenderTarget } from './null/render-target';
export { NullSurface } from './null/surface';
export {
  RHIDeviceRequestError,
  RHIUnsupportedOperationError,
  WebGPUNativeDeviceRequestError,
  WebGPUNativeOperationError
} from './contracts/errors';
export type { WebGL2ClipDepthMode } from './webgl2/pipeline/clip-depth';
export type {
  WebGL2AdapterFacts,
  WebGL2NativeContextInfo,
  WebGL2NativeContextLostInfo,
  WebGL2NativeContextPort,
  WebGL2NativeLimits
} from './webgl2/types';
export type {
  FinalizedWebGL2Shader,
  WebGL2BindingKind,
  WebGL2BindingManifestEntry,
  WebGL2PhysicalBinding,
  WebGL2ProgramBinding,
  WebGL2ShaderStage,
  WebGL2ShaderTranslationPort,
  WebGL2TranslatedShader
} from './webgl2/types';
export { finalizeWebGL2Shader } from './webgl2/pipeline/shader-finalization';
export type { WebGL2MetricsSnapshot } from './webgl2/metrics';
export type { WebGL2ContextControl } from './webgl2/types';
export type {
  WebGPUNativeAdapterInfo,
  WebGPUNativeAdapterPort,
  WebGPUNativeBufferPort,
  WebGPUNativeCanvasContextPort,
  WebGPUNativeCommandEncoderPort,
  WebGPUNativeComputePassPort,
  WebGPUNativeDeviceLostInfo,
  WebGPUNativeDevicePort,
  WebGPUNativeDeviceRequest,
  WebGPUNativeErrorPort,
  WebGPUNativeErrorType,
  WebGPUNativeImportTexturePort,
  WebGPUNativeQueuePort,
  WebGPUNativeResourcePort,
  WebGPUNativeRenderPassPort,
  WebGPUNativeSurfaceAcquireResult,
  WebGPUNativeSurfaceConfiguration,
  WebGPUNativeTexturePort
} from './webgpu/types';
export type { GPUImageCopyBuffer } from './contracts/resource';
export type {
  NativeImportDescriptorMap,
  RHINativeResourceMap,
  WebGPUInterop,
  WebGPUInteropScope,
  WebGPUInteropSubmissionPolicy,
  WebGPUNativeImportKind,
  WebGPUNativeKind,
  WebGPUNativeResourceMap
} from './webgpu/types';
export type { RHIExtensionToken } from './contracts/extension';
export type { WebGPUPipelineCreationResult } from './webgpu/types';
export type { WebGPUFastPathMetrics } from './webgpu/metrics';
export { webgpuCompat } from './core/webgpu-compat';
export type {
  AdapterCapabilities,
  DeviceCapabilities,
  FeatureSupport,
  FormatCapabilities,
  QueueCapability,
  RHIBackend,
  RHICapabilityRequirement,
  RHIFeature,
  RHILimits,
  RHIOperation,
  RHIQueueRole,
  SupportStatus
} from './contracts/capability';
export type {
  AdapterInfo,
  DeviceRequest,
  DeviceRequestDifference,
  RHIAdapter
} from './contracts/adapter';
export type { DeviceLostInfo, RHIDeviceState, RHIResourceState } from './contracts/lifecycle';
export type {
  RHIQueueMetrics,
  RHISubmission,
  RHISubmissionStatus,
  SubmissionResult
} from './contracts/submission';
export type {
  RHISurface,
  RHISurfaceAcquireResult,
  RHISurfaceConfiguration,
  RHISurfaceFrame,
  RHISurfaceFrameState,
  RHISurfaceState
} from './contracts/surface';
export type {
  RHIBindGroupLayoutDescriptor,
  RHIBindGroupDescriptor,
  RHIBufferDescriptor,
  RHICommandBufferDescriptor,
  RHICommandEncoderDescriptor,
  RHIComputePassDescriptor,
  RHIPipelineLayoutDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor,
  RHITextureViewDescriptor
} from './contracts/descriptor';
export type {
  ColorAttachmentDescriptor,
  BufferWriteRange,
  DepthStencilAttachmentDescriptor,
  GPUBindGroupDescriptor,
  GPUBindGroupEntry,
  GPUBindGroupLayoutDescriptor,
  GPUBindGroupLayoutEntry,
  GPUBindingResource,
  GPUBufferBinding,
  GPUBufferBindingLayout,
  GPUComputePassDescriptor,
  GPUImageCopyTexture,
  GPUImageDataLayout,
  GPUOrigin3D,
  GPUPipelineLayoutDescriptor,
  GPUSamplerBindingLayout,
  GPUShaderModuleDescriptor,
  GPUShaderStageFlags,
  GPUTextureAspect,
  GPUStorageTextureBindingLayout,
  GPUTextureBindingLayout,
  RHICopyStats,
  RHICommandBuffer,
  RHICommandEncoder,
  RHICommandRecord,
  RHICommandStats,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIComputeStats,
  RHIDevice,
  RHIDrawStats,
  RHIPipelineLayout,
  RHIRenderPassDescriptor,
  RHIRenderPassEncoder,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHIRenderTarget,
  RHIResource,
  RHIResourceKind,
  RHIResourceRef,
  RHIUploadData,
  RHISampler,
  RHIShaderModule,
  RHITexture,
  RHITextureView,
  RenderTargetDescriptor
} from './contracts';

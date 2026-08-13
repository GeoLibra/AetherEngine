import type { FormatCapabilities, RHILimits } from '../../contracts/capability';
import type { GPUTextureFormat } from '../../contracts/webgpu';
import type { WebGPUNativeAdapterPort, WebGPUNativeDeviceRequest } from '../native-types';
import { lowerBrowserDeviceRequest } from './device-port';
import type {
  BrowserWebGPUAdapterRequestOptions,
  BrowserWebGPUEnvironment
} from './types';

const BROWSER_WEBGPU_FORMATS: readonly GPUTextureFormat[] = Object.freeze([
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float'
]);

const WEBGPU_LIMIT_NAMES = Object.freeze([
  'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
  'maxTextureArrayLayers', 'maxBindGroups', 'maxBindGroupsPlusVertexBuffers',
  'maxBindingsPerBindGroup', 'maxDynamicUniformBuffersPerPipelineLayout',
  'maxDynamicStorageBuffersPerPipelineLayout', 'maxSampledTexturesPerShaderStage',
  'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize',
  'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
  'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes',
  'maxVertexBufferArrayStride', 'maxInterStageShaderVariables',
  'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension'
]);

export async function requestBrowserWebGPUAdapter(
  environment: BrowserWebGPUEnvironment,
  options: BrowserWebGPUAdapterRequestOptions
): Promise<WebGPUNativeAdapterPort | null> {
  const requestOptions = Object.freeze({
    ...(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference }),
    ...(options.forceFallbackAdapter === undefined ? {} : {
      forceFallbackAdapter: options.forceFallbackAdapter
    })
  });
  const nativeValue = await environment.gpu.requestAdapter(requestOptions);
  if (nativeValue === null) return null;
  const native = requireObject(nativeValue, 'GPUAdapter');
  const info = snapshotInfo(Reflect.get(native, 'info'));
  const features = snapshotStringSet(Reflect.get(native, 'features'));
  const limits = snapshotLimits(Reflect.get(native, 'limits'));

  return Object.freeze({
    info,
    features,
    limits,
    formats: createFormatCapabilities(),
    requestDevice: (request: WebGPUNativeDeviceRequest) => lowerBrowserDeviceRequest(native, request)
  });
}

function snapshotInfo(value: unknown) {
  const info = requireObject(value, 'GPUAdapter.info');
  const vendor = optionalString(info, 'vendor');
  const architecture = optionalString(info, 'architecture');
  const description = optionalString(info, 'description');
  return Object.freeze({
    name: description ?? vendor ?? 'Browser WebGPU Adapter',
    ...(vendor === undefined || vendor.length === 0 ? {} : { vendor }),
    ...(architecture === undefined || architecture.length === 0 ? {} : { architecture })
  });
}

function snapshotStringSet(value: unknown): ReadonlySet<string> {
  if (value === null || value === undefined || typeof Reflect.get(value as object, Symbol.iterator) !== 'function') {
    throw new TypeError('GPUAdapter.features is not iterable.');
  }
  return new Set(Array.from(value as Iterable<unknown>, (entry) => String(entry)));
}

function snapshotLimits(value: unknown): RHILimits {
  const limits = requireObject(value, 'GPUAdapter.limits');
  const result: Record<string, number> = {};
  for (const key of WEBGPU_LIMIT_NAMES) {
    const entry = Reflect.get(limits, key);
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
  }
  return Object.freeze(result);
}

function createFormatCapabilities(): ReadonlyMap<GPUTextureFormat, FormatCapabilities> {
  return new Map(BROWSER_WEBGPU_FORMATS.map((format) => [format, Object.freeze({
    sample: true,
    filter: !format.startsWith('depth'),
    render: true,
    blend: !format.startsWith('depth'),
    storage: format === 'rgba8unorm',
    copySrc: true,
    copyDst: true,
    sampleCounts: Object.freeze([1, 4])
  })]));
}

function optionalString(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === 'string' ? value : undefined;
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${label} is not an object.`);
  return value;
}

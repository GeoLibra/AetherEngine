import type { AdapterInfo, DeviceRequest, RHIAdapter } from '../contracts/adapter';
import { DiagnosticStore } from '../../diagnostics';
import { collectDeviceRequestDifferences } from '../core/adapter-validation';
import { createCapabilitySnapshot, FULL_FEATURE_QUEUES, RHI_FEATURES } from '../core/capabilities';
import type { AdapterCapabilities, FeatureSupport, RHIFeature } from '../contracts/capability';
import { RHIDeviceRequestError, WebGPUNativeDeviceRequestError } from '../contracts/errors';
import { WebGPUDevice } from './device';
import type { WebGPUNativeAdapterPort, WebGPUNativeDeviceRequest } from './types';
import { WEBGPU_CORE_FEATURES } from './core-features';

export class WebGPUAdapter implements RHIAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;

  constructor(
    private readonly native: WebGPUNativeAdapterPort,
    readonly diagnostics = new DiagnosticStore()
  ) {
    this.info = createAdapterInfo(native);
    this.capabilities = createWebGPUCapabilities(native, new Set(['timestamp-query']));
  }

  async requestDevice(request: DeviceRequest): Promise<WebGPUDevice> {
    const missing = collectDeviceRequestDifferences(this.capabilities, request);
    if (missing.length > 0) throw new RHIDeviceRequestError(missing);

    const selectedExtensions = new Set<RHIFeature>();
    for (const feature of [...request.requiredFeatures, ...request.optionalFeatures]) {
      if (
        feature === 'timestamp-query' &&
        this.capabilities.features.get(feature)?.status === 'native'
      ) {
        selectedExtensions.add(feature);
      }
    }
    const nativeRequest = createNativeRequest(request, selectedExtensions);
    try {
      const nativeDevice = await this.native.requestDevice(nativeRequest);
      return new WebGPUDevice(
        createWebGPUCapabilities(this.native, selectedExtensions),
        nativeDevice,
        this.diagnostics
      );
    } catch (cause) {
      throw new WebGPUNativeDeviceRequestError(this.info.name, request.label, cause);
    }
  }
}

function createAdapterInfo(native: WebGPUNativeAdapterPort): AdapterInfo {
  const info: AdapterInfo = {
    name: native.info.name,
    backend: 'webgpu',
    ...(native.info.vendor === undefined ? {} : { vendor: native.info.vendor }),
    ...(native.info.architecture === undefined ? {} : { architecture: native.info.architecture })
  };
  return Object.freeze(info);
}

function createWebGPUCapabilities(
  native: WebGPUNativeAdapterPort,
  selectedExtensions: ReadonlySet<RHIFeature>
): AdapterCapabilities {
  const features = new Map<RHIFeature, FeatureSupport>();
  for (const feature of RHI_FEATURES) {
    if (WEBGPU_CORE_FEATURES.includes(feature)) {
      features.set(feature, { status: 'native' });
    } else if (
      feature === 'timestamp-query' &&
      native.features.has(feature) &&
      selectedExtensions.has(feature)
    ) {
      features.set(feature, { status: 'native' });
    } else {
      features.set(feature, {
        status: 'unsupported',
        reason: native.features.has(feature)
          ? 'Feature was not requested for this WebGPU device.'
          : 'Feature is not reported by the WebGPU adapter.'
      });
    }
  }
  return createCapabilitySnapshot({
    backend: 'webgpu',
    features,
    limits: native.limits,
    formats: native.formats,
    queues: FULL_FEATURE_QUEUES
  });
}

function createNativeRequest(
  request: DeviceRequest,
  selectedExtensions: ReadonlySet<RHIFeature>
): WebGPUNativeDeviceRequest {
  const nativeRequest: WebGPUNativeDeviceRequest = {
    requiredFeatures: Object.freeze([...selectedExtensions]),
    requiredLimits: Object.freeze({ ...(request.requiredLimits ?? {}) })
  };
  if (request.label !== undefined) {
    return Object.freeze({ ...nativeRequest, label: request.label });
  }
  return Object.freeze(nativeRequest);
}

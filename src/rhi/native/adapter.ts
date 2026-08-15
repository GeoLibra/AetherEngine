import { DiagnosticStore } from '../../diagnostics';
import type { AdapterInfo, DeviceRequest, RHIAdapter } from '../contracts/adapter';
import { collectDeviceRequestDifferences } from '../core/adapter-validation';
import type { AdapterCapabilities, RHIFeature } from '../contracts/capability';
import { RHIDeviceRequestError } from '../contracts/errors';
import { WebGPUDevice } from '../webgpu/device';
import type { WebGPUNativeDeviceRequest } from '../webgpu/types';
import { createNativeDawnCapabilities } from './capabilities';
import type { NativeDawnAdapterFacts, NativeDawnAdapterPort } from './types';

export class NativeDawnDeviceRequestError extends Error {
  readonly code = 'rhi/native-dawn-device-request-failed' as const;
  constructor(
    readonly adapterName: string,
    readonly deviceLabel: string | undefined,
    override readonly cause: unknown
  ) {
    super(`Native Dawn adapter "${adapterName}" failed to create a device.`);
    this.name = 'NativeDawnDeviceRequestError';
  }
}

export class NativeDawnAdapter implements RHIAdapter {
  readonly info: AdapterInfo;
  readonly facts: NativeDawnAdapterFacts;
  readonly capabilities: AdapterCapabilities;

  constructor(
    private readonly native: NativeDawnAdapterPort,
    readonly diagnostics = new DiagnosticStore()
  ) {
    if (native.dawn.version.trim().length === 0)
      throw new Error('Native Dawn version must not be empty.');
    if (!['metal', 'vulkan', 'd3d12'].includes(native.dawn.backend)) {
      throw new Error('Native Dawn backend is unsupported.');
    }
    this.info = Object.freeze({
      name: native.info.name,
      backend: 'native' as const,
      ...(native.info.vendor === undefined ? {} : { vendor: native.info.vendor }),
      ...(native.info.architecture === undefined ? {} : { architecture: native.info.architecture })
    });
    this.facts = Object.freeze({
      dawnVersion: native.dawn.version,
      nativeBackend: native.dawn.backend
    });
    this.capabilities = createNativeDawnCapabilities(native, new Set(['timestamp-query']));
  }

  async requestDevice(request: DeviceRequest): Promise<WebGPUDevice> {
    const missing = collectDeviceRequestDifferences(this.capabilities, request);
    if (missing.length > 0) throw new RHIDeviceRequestError(missing);
    const extensions = selectExtensions(request, this.capabilities);
    try {
      const device = await this.native.requestDevice(createNativeRequest(request, extensions));
      // The WebGPU-like Dawn port is the RHI hot path; generic bridge dispatch is intentionally absent.
      return new WebGPUDevice(
        createNativeDawnCapabilities(this.native, extensions),
        device,
        this.diagnostics
      );
    } catch (cause) {
      throw new NativeDawnDeviceRequestError(this.info.name, request.label, cause);
    }
  }
}

function selectExtensions(
  request: DeviceRequest,
  capabilities: AdapterCapabilities
): ReadonlySet<RHIFeature> {
  const selected = new Set<RHIFeature>();
  for (const feature of [...request.requiredFeatures, ...request.optionalFeatures]) {
    if (feature === 'timestamp-query' && capabilities.features.get(feature)?.status === 'native') {
      selected.add(feature);
    }
  }
  return selected;
}

function createNativeRequest(
  request: DeviceRequest,
  extensions: ReadonlySet<RHIFeature>
): WebGPUNativeDeviceRequest {
  const nativeRequest: WebGPUNativeDeviceRequest = Object.freeze({
    requiredFeatures: Object.freeze([...extensions]),
    requiredLimits: Object.freeze({ ...(request.requiredLimits ?? {}) })
  });
  return request.label === undefined
    ? nativeRequest
    : Object.freeze({ ...nativeRequest, label: request.label });
}

import type { AdapterInfo, DeviceRequest, RHIAdapter } from '../contracts/adapter';
import { collectDeviceRequestDifferences } from '../core/adapter-validation';
import type { AdapterCapabilities } from '../contracts/capability';
import { RHIDeviceRequestError } from '../contracts/errors';
import { createWebGL2Capabilities, createWebGL2Facts } from './capabilities';
import { WebGL2Device } from './device';
import type { WebGL2AdapterFacts, WebGL2NativeContextPort } from './native-types';
import type { WebGL2ShaderTranslationPort } from './shader-types';

export class WebGL2Adapter implements RHIAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  readonly facts: WebGL2AdapterFacts;

  constructor(
    private readonly native: WebGL2NativeContextPort,
    private readonly translator?: WebGL2ShaderTranslationPort
  ) {
    this.info = createAdapterInfo(native);
    this.capabilities = createWebGL2Capabilities(native);
    this.facts = createWebGL2Facts(native);
  }

  async requestDevice(request: DeviceRequest): Promise<WebGL2Device> {
    const missing = collectDeviceRequestDifferences(this.capabilities, request);
    if (missing.length > 0) throw new RHIDeviceRequestError(missing);
    return new WebGL2Device(this.capabilities, this.native, this.translator);
  }
}

function createAdapterInfo(native: WebGL2NativeContextPort): AdapterInfo {
  return Object.freeze({
    name: native.info.name,
    backend: 'webgl2',
    ...(native.info.vendor === undefined ? {} : { vendor: native.info.vendor }),
    ...(native.info.renderer === undefined ? {} : { architecture: native.info.renderer })
  });
}

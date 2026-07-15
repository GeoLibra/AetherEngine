import type { SurfaceTarget } from '../../platform/types';
import type { RHIDevice } from '../contracts/device';
import type { RHITexture } from '../contracts/resource';
import type {
  RHISurface,
  RHISurfaceAcquireResult,
  RHISurfaceConfiguration,
  RHISurfaceFrame,
  RHISurfaceFrameState,
  RHISurfaceState
} from '../contracts/surface';

const TEXTURE_USAGE_RENDER_ATTACHMENT = 1 << 4;

type NullInjectedAcquireStatus = Exclude<
  RHISurfaceAcquireResult['status'],
  'success' | 'zero-extent' | 'device-lost'
>;

export class NullSurface implements RHISurface {
  private currentState: RHISurfaceState = 'unconfigured';
  private currentGeneration = 0;
  private currentConfiguration: RHISurfaceConfiguration | undefined;
  private currentDevice: RHIDevice | undefined;
  private activeFrame: NullSurfaceFrame | undefined;
  private readonly injectedStatuses: NullInjectedAcquireStatus[] = [];
  private frameCount = 0;
  private configuredWindowGeneration = 0;

  constructor(readonly target: SurfaceTarget) {}

  get state(): RHISurfaceState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get configuration(): RHISurfaceConfiguration | undefined {
    return this.currentConfiguration;
  }

  get windowGeneration(): number {
    return this.configuredWindowGeneration;
  }

  get acquiredFrameCount(): number {
    return this.frameCount;
  }

  configure(
    device: RHIDevice,
    configuration: RHISurfaceConfiguration,
    windowGeneration: number
  ): void {
    this.assertNotDisposed();
    validateConfiguration(configuration);
    validateWindowGeneration(windowGeneration);
    if (device.state !== 'live') {
      throw new Error('Cannot configure NullSurface with a lost or destroyed device.');
    }

    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.currentDevice = device;
    this.currentConfiguration = Object.freeze({ ...configuration });
    this.configuredWindowGeneration = windowGeneration;
    this.currentGeneration += 1;
    this.currentState = 'configured';
    this.injectedStatuses.length = 0;
  }

  acquire(): RHISurfaceAcquireResult {
    this.assertNotDisposed();
    if (this.currentState === 'lost') return frozenStatus('lost');
    if (this.currentState !== 'configured' || this.currentDevice === undefined || this.currentConfiguration === undefined) {
      throw new Error('NullSurface must be configured before acquire.');
    }
    if (this.currentDevice.state !== 'live') return frozenStatus('device-lost');
    if (this.activeFrame !== undefined) return frozenStatus('timeout');

    const injected = this.injectedStatuses.shift();
    if (injected !== undefined) {
      if (injected === 'lost') this.currentState = 'lost';
      return frozenStatus(injected);
    }
    if (this.currentConfiguration.width === 0 || this.currentConfiguration.height === 0) {
      return frozenStatus('zero-extent');
    }

    const texture = this.currentDevice.createTexture({
      label: `surface-frame-${this.currentGeneration}-${this.frameCount + 1}`,
      size: {
        width: this.currentConfiguration.width,
        height: this.currentConfiguration.height,
        depthOrArrayLayers: 1
      },
      format: this.currentConfiguration.format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const frame = new NullSurfaceFrame(texture, this.currentGeneration, () => {
      if (this.activeFrame === frame) this.activeFrame = undefined;
    });
    this.activeFrame = frame;
    this.frameCount += 1;
    return Object.freeze({ status: 'success', frame });
  }

  enqueueAcquireStatusForTesting(status: NullInjectedAcquireStatus): void {
    this.assertNotDisposed();
    this.injectedStatuses.push(status);
  }

  loseForTesting(): void {
    this.assertNotDisposed();
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.currentState = 'lost';
  }

  dispose(): void {
    if (this.currentState === 'disposed') return;
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.currentDevice = undefined;
    this.currentConfiguration = undefined;
    this.injectedStatuses.length = 0;
    this.currentState = 'disposed';
  }

  private assertNotDisposed(): void {
    if (this.currentState === 'disposed') throw new Error('NullSurface has been disposed.');
  }
}

class NullSurfaceFrame implements RHISurfaceFrame {
  private currentState: RHISurfaceFrameState = 'acquired';

  constructor(
    readonly texture: RHITexture,
    readonly generation: number,
    private readonly onTerminal: () => void
  ) {}

  get state(): RHISurfaceFrameState {
    return this.currentState;
  }

  present(): void {
    if (this.currentState === 'presented') throw new Error('Surface frame has already been presented.');
    if (this.currentState === 'released') throw new Error('Released surface frame cannot be presented.');
    this.currentState = 'presented';
    this.texture.dispose();
    this.onTerminal();
  }

  release(): void {
    if (this.currentState === 'presented') throw new Error('Presented surface frame cannot be released.');
    if (this.currentState === 'released') throw new Error('Surface frame has already been released.');
    this.abandon();
  }

  abandon(): void {
    if (this.currentState !== 'acquired') return;
    this.currentState = 'released';
    this.texture.dispose();
    this.onTerminal();
  }
}

function validateConfiguration(configuration: RHISurfaceConfiguration): void {
  validateExtent(configuration.width, 'width');
  validateExtent(configuration.height, 'height');
}

function validateExtent(value: number, name: 'width' | 'height'): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Surface ${name} must be a non-negative integer.`);
  }
}

function validateWindowGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('Window generation must be a non-negative integer.');
  }
}

function frozenStatus<T extends Exclude<RHISurfaceAcquireResult['status'], 'success'>>(
  status: T
): Extract<RHISurfaceAcquireResult, { status: T }> {
  return Object.freeze({ status }) as Extract<RHISurfaceAcquireResult, { status: T }>;
}

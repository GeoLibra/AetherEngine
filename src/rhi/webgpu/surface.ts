import type { SurfaceTarget } from '../../platform/types';
import type { RHIDevice } from '../contracts/device';
import type {
  RHISurface,
  RHISurfaceAcquireResult,
  RHISurfaceConfiguration,
  RHISurfaceFrame,
  RHISurfaceFrameState,
  RHISurfaceState
} from '../contracts/surface';
import { WebGPUDevice } from './device';
import type { WebGPUNativeCanvasContextPort } from './types';
import type { WebGPUTexture } from './resource';

export class WebGPUSurface implements RHISurface {
  private currentState: RHISurfaceState = 'unconfigured';
  private currentGeneration = 0;
  private currentConfiguration: RHISurfaceConfiguration | undefined;
  private currentDevice: WebGPUDevice | undefined;
  private activeFrame: WebGPUSurfaceFrame | undefined;
  private frameCount = 0;

  constructor(
    readonly target: SurfaceTarget,
    private readonly context: WebGPUNativeCanvasContextPort
  ) {}

  get state(): RHISurfaceState {
    return this.currentState;
  }
  get generation(): number {
    return this.currentGeneration;
  }
  get configuration(): RHISurfaceConfiguration | undefined {
    return this.currentConfiguration;
  }

  configure(
    device: RHIDevice,
    configuration: RHISurfaceConfiguration,
    windowGeneration: number
  ): void {
    this.assertNotDisposed();
    validateConfiguration(configuration);
    validateWindowGeneration(windowGeneration);
    if (!(device instanceof WebGPUDevice)) {
      throw new Error('WebGPUSurface requires a WebGPUDevice.');
    }
    if (device.state !== 'live') {
      throw new Error('Cannot configure WebGPUSurface with a lost or destroyed device.');
    }

    const snapshot = Object.freeze({ ...configuration });
    if (snapshot.width > 0 && snapshot.height > 0) {
      device.configureSurface(this.context, snapshot);
    }
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.currentDevice = device;
    this.currentConfiguration = snapshot;
    this.currentGeneration += 1;
    this.currentState = 'configured';
  }

  acquire(): RHISurfaceAcquireResult {
    this.assertNotDisposed();
    if (this.currentState === 'lost') return frozenStatus('lost');
    if (
      this.currentState !== 'configured' ||
      this.currentDevice === undefined ||
      this.currentConfiguration === undefined
    ) {
      throw new Error('WebGPUSurface must be configured before acquire.');
    }
    if (this.currentDevice.state !== 'live') return frozenStatus('device-lost');
    if (this.activeFrame !== undefined) return frozenStatus('timeout');
    if (this.currentConfiguration.width === 0 || this.currentConfiguration.height === 0) {
      return frozenStatus('zero-extent');
    }

    const acquired = this.context.getCurrentTexture();
    if (acquired.status !== 'success') {
      if (acquired.status === 'lost') this.currentState = 'lost';
      return frozenStatus(acquired.status);
    }

    const texture = this.currentDevice.createSurfaceTexture(
      acquired.texture,
      this.currentConfiguration,
      `surface-frame-${this.currentGeneration}-${this.frameCount + 1}`
    );
    const frame = new WebGPUSurfaceFrame(
      texture,
      this.currentGeneration,
      () => this.context.present?.(),
      () => {
        if (this.activeFrame === frame) this.activeFrame = undefined;
      }
    );
    this.activeFrame = frame;
    this.frameCount += 1;
    return Object.freeze({ status: 'success', frame });
  }

  dispose(): void {
    if (this.currentState === 'disposed') return;
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.context.unconfigure?.();
    this.currentDevice = undefined;
    this.currentConfiguration = undefined;
    this.currentState = 'disposed';
  }

  private assertNotDisposed(): void {
    if (this.currentState === 'disposed') throw new Error('WebGPUSurface has been disposed.');
  }
}

class WebGPUSurfaceFrame implements RHISurfaceFrame {
  private currentState: RHISurfaceFrameState = 'acquired';

  constructor(
    readonly texture: WebGPUTexture,
    readonly generation: number,
    private readonly presentNative: () => void,
    private readonly onTerminal: () => void
  ) {}

  get state(): RHISurfaceFrameState {
    return this.currentState;
  }

  present(): void {
    if (this.currentState === 'presented')
      throw new Error('Surface frame has already been presented.');
    if (this.currentState === 'released')
      throw new Error('Released surface frame cannot be presented.');
    this.presentNative();
    this.currentState = 'presented';
    this.texture.dispose();
    this.onTerminal();
  }

  release(): void {
    if (this.currentState === 'presented')
      throw new Error('Presented surface frame cannot be released.');
    if (this.currentState === 'released')
      throw new Error('Surface frame has already been released.');
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

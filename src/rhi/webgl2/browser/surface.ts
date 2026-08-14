import type { SurfaceTarget } from '../../../platform/types';
import type { RHIDevice } from '../../contracts/device';
import type { RHITexture } from '../../contracts/resource';
import type {
  RHISurface,
  RHISurfaceAcquireResult,
  RHISurfaceConfiguration,
  RHISurfaceFrame,
  RHISurfaceFrameState,
  RHISurfaceState
} from '../../contracts/surface';
import { WebGL2Device } from '../device';

export class WebGL2BrowserSurface implements RHISurface {
  private currentState: RHISurfaceState = 'unconfigured';
  private currentGeneration = 0;
  private currentConfiguration: RHISurfaceConfiguration | undefined;
  private device: WebGL2Device | undefined;
  private activeFrame: WebGL2SurfaceFrame | undefined;
  private backingTexture: RHITexture | undefined;

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

  configure(
    device: RHIDevice,
    configuration: RHISurfaceConfiguration,
    windowGeneration: number
  ): void {
    if (this.currentState === 'disposed') throw new Error('WebGL2 surface has been disposed.');
    if (!(device instanceof WebGL2Device))
      throw new Error('WebGL2 surface requires a WebGL2Device.');
    if (!Number.isInteger(windowGeneration) || windowGeneration < 0)
      throw new Error('Window generation must be a non-negative integer.');
    validateExtent(configuration.width, 'width');
    validateExtent(configuration.height, 'height');
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.disposeBackingTexture();
    this.device = device;
    this.currentConfiguration = Object.freeze({ ...configuration });
    this.currentGeneration += 1;
    this.currentState = 'configured';
  }

  acquire(): RHISurfaceAcquireResult {
    if (this.currentState === 'disposed') throw new Error('WebGL2 surface has been disposed.');
    const device = this.device;
    const configuration = this.currentConfiguration;
    if (this.currentState !== 'configured' || device === undefined || configuration === undefined)
      throw new Error('WebGL2 surface must be configured before acquire.');
    if (device.state !== 'live') return Object.freeze({ status: 'device-lost' });
    if (this.activeFrame !== undefined) return Object.freeze({ status: 'timeout' });
    if (configuration.width === 0 || configuration.height === 0)
      return Object.freeze({ status: 'zero-extent' });
    const descriptor = {
      label: `webgl2-surface-${this.currentGeneration}`,
      size: [configuration.width, configuration.height] as const,
      format:
        configuration.format === 'bgra8unorm' ? ('rgba8unorm' as const) : configuration.format,
      usage: 0x13
    };
    this.backingTexture ??= device.createSurfaceBackingTexture(descriptor);
    const texture = device.createSurfaceTextureLease(this.backingTexture);
    const frame = new WebGL2SurfaceFrame(texture, this.currentGeneration, device, () => {
      if (this.activeFrame === frame) this.activeFrame = undefined;
    });
    this.activeFrame = frame;
    return Object.freeze({ status: 'success', frame });
  }

  dispose(): void {
    if (this.currentState === 'disposed') return;
    this.activeFrame?.abandon();
    this.activeFrame = undefined;
    this.disposeBackingTexture();
    this.device = undefined;
    this.currentConfiguration = undefined;
    this.currentState = 'disposed';
  }

  private disposeBackingTexture(): void {
    this.backingTexture?.dispose();
    this.backingTexture = undefined;
  }
}

class WebGL2SurfaceFrame implements RHISurfaceFrame {
  private currentState: RHISurfaceFrameState = 'acquired';
  constructor(
    readonly texture: RHITexture,
    readonly generation: number,
    private readonly device: WebGL2Device,
    private readonly terminal: () => void
  ) {}
  get state(): RHISurfaceFrameState {
    return this.currentState;
  }
  present(): void {
    this.assertAcquired();
    this.device.presentSurfaceTexture(this.texture);
    this.currentState = 'presented';
    this.texture.dispose();
    this.terminal();
  }
  release(): void {
    this.assertAcquired();
    this.abandon();
  }
  abandon(): void {
    if (this.currentState !== 'acquired') return;
    this.currentState = 'released';
    this.texture.dispose();
    this.terminal();
  }
  private assertAcquired(): void {
    if (this.currentState !== 'acquired')
      throw new Error('WebGL2 surface frame is no longer acquired.');
  }
}

function validateExtent(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`Surface ${name} must be a non-negative integer.`);
}

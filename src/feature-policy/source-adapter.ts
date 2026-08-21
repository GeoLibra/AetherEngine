import type { RHIDevice } from '../rhi/contracts/device';
import type { RHISurface, RHISurfaceConfiguration } from '../rhi/contracts/surface';
import type { FeaturePolicySourceRevisions } from './revision';

const FEATURE_POLICY_SOURCE_NAMES = ['capabilities', 'profile', 'registry', 'budget'] as const;
type FeaturePolicySourceName = (typeof FEATURE_POLICY_SOURCE_NAMES)[number];

interface MutableSourceRevisions {
  capabilities: number;
  profile: number;
  registry: number;
  budget: number;
}

interface GraphicsFacts {
  readonly deviceGeneration: number;
  readonly deviceState: RHIDevice['state'];
  readonly surfaceGeneration: number;
  readonly surfaceState: RHISurface['state'];
  readonly format: RHISurfaceConfiguration['format'] | undefined;
  readonly colorSpace: RHISurfaceConfiguration['colorSpace'] | undefined;
  readonly alphaMode: RHISurfaceConfiguration['alphaMode'] | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly presentMode: RHISurfaceConfiguration['presentMode'] | undefined;
}

/**
 * Adapts public graphics and product events to FeaturePolicy source revisions.
 *
 * The adapter retains copied primitive facts only. It does not own the device,
 * surface, product payloads, resolution, preparation, or frame-boundary publish.
 */
export class FeaturePolicySourceAdapter {
  private readonly current: MutableSourceRevisions;
  private graphics: GraphicsFacts | undefined;

  constructor(initial: FeaturePolicySourceRevisions = emptySourceRevisions()) {
    validateSourceRevisions(initial);
    this.current = { ...initial };
  }

  /** Returns a detached source vector suitable for FeaturePolicyRevisionTracker. */
  get revisions(): FeaturePolicySourceRevisions {
    return { ...this.current };
  }

  /**
   * Observes public device and surface compatibility facts.
   *
   * Returns `true` only when the capability source revision advanced.
   */
  observeGraphics(device: RHIDevice, surface: RHISurface): boolean {
    const configuration = surface.configuration;
    const next: GraphicsFacts = {
      deviceGeneration: device.generation,
      deviceState: device.state,
      surfaceGeneration: surface.generation,
      surfaceState: surface.state,
      format: configuration?.format,
      colorSpace: configuration?.colorSpace,
      alphaMode: configuration?.alphaMode,
      width: configuration?.width,
      height: configuration?.height,
      presentMode: configuration?.presentMode
    };
    if (this.graphics !== undefined && equalGraphicsFacts(this.graphics, next)) return false;
    this.graphics = next;
    this.advance('capabilities');
    return true;
  }

  /** Records a user quality or product profile change. */
  profileChanged(): number {
    return this.advance('profile');
  }

  /** Records a FeatureImplementation registry change. */
  registryChanged(): number {
    return this.advance('registry');
  }

  /** Records a memory-pressure or resource-budget change. */
  budgetChanged(): number {
    return this.advance('budget');
  }

  private advance(source: FeaturePolicySourceName): number {
    const revision = this.current[source];
    if (revision === Number.MAX_SAFE_INTEGER) {
      throw new Error(`FeaturePolicy ${source} source revision exhausted the safe-integer range.`);
    }
    const next = revision + 1;
    this.current[source] = next;
    return next;
  }
}

function emptySourceRevisions(): FeaturePolicySourceRevisions {
  return { capabilities: 0, profile: 0, registry: 0, budget: 0 };
}

function validateSourceRevisions(revisions: FeaturePolicySourceRevisions): void {
  for (const name of FEATURE_POLICY_SOURCE_NAMES) {
    const revision = revisions[name];
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`FeaturePolicy ${name} source revision must be a non-negative safe integer.`);
    }
  }
}

function equalGraphicsFacts(left: GraphicsFacts, right: GraphicsFacts): boolean {
  return (
    left.deviceGeneration === right.deviceGeneration &&
    left.deviceState === right.deviceState &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.surfaceState === right.surfaceState &&
    left.format === right.format &&
    left.colorSpace === right.colorSpace &&
    left.alphaMode === right.alphaMode &&
    left.width === right.width &&
    left.height === right.height &&
    left.presentMode === right.presentMode
  );
}

import { FeaturePolicyCoordinator } from './coordinator';
import { copyFeaturePolicyInspection, createFeaturePolicyInspection } from './inspection';
import { FeaturePolicyRevisionTracker } from './revision';
import { FeaturePolicySourceAdapter } from './source-adapter';
import type {
  FeaturePolicyInput,
  FeaturePolicyInspection,
  FeaturePolicyPrepareResult,
  FeaturePolicyPublication,
  PreparedFeaturePolicy
} from './types';

export type FeaturePolicyRuntimeInput = Omit<FeaturePolicyInput, 'revision'>;
export type FeaturePolicyRuntimeState = 'idle' | 'preparing' | 'awaiting-publish' | 'destroyed';

type SuccessfulPrepareResult = Extract<FeaturePolicyPrepareResult, { readonly ok: true }>;
type FailedPrepareResult = Extract<FeaturePolicyPrepareResult, { readonly ok: false }>;

export type FeaturePolicyRuntimeStageResult =
  | { readonly status: 'unchanged' }
  | { readonly status: 'preparing' }
  | { readonly status: 'awaiting-publish' }
  | { readonly status: 'prepared'; readonly result: SuccessfulPrepareResult }
  | { readonly status: 'failed'; readonly result: FailedPrepareResult };

/**
 * Owns the event-to-prepare-to-frame-publication FeaturePolicy state machine.
 *
 * External event owners update {@link sources} and call {@link stage} outside
 * synchronous frame schedules. The frame owner calls {@link publishFrameBoundary}
 * and remains responsible for forwarding invalidations and releasing retirement
 * only after relevant submissions become terminal.
 */
export class FeaturePolicyRuntimeController {
  readonly sources = new FeaturePolicySourceAdapter();
  private readonly revisions = new FeaturePolicyRevisionTracker();
  private readonly coordinator = new FeaturePolicyCoordinator();
  private currentState: FeaturePolicyRuntimeState = 'idle';
  private destroyed = false;
  private latestInspection: FeaturePolicyInspection | undefined;

  get state(): FeaturePolicyRuntimeState {
    return this.currentState;
  }

  get current(): PreparedFeaturePolicy | undefined {
    return this.coordinator.current;
  }

  /** Latest successful or failed resolution evidence available to read-only tools. */
  get inspection(): FeaturePolicyInspection | undefined {
    return this.latestInspection === undefined
      ? undefined
      : copyFeaturePolicyInspection(this.latestInspection);
  }

  /**
   * Resolves and prepares the latest changed source vector.
   *
   * Calls made while preparation or publication is pending do not consume the
   * latest source vector, so the caller can stage it after the current publish.
   */
  async stage(input: FeaturePolicyRuntimeInput): Promise<FeaturePolicyRuntimeStageResult> {
    this.assertActive();
    if (this.currentState === 'preparing') return { status: 'preparing' };
    if (this.currentState === 'awaiting-publish') return { status: 'awaiting-publish' };

    const revisioned = this.revisions.capture(this.sources.revisions, input);
    if (revisioned === undefined) return { status: 'unchanged' };

    this.currentState = 'preparing';
    const result = await this.coordinator.prepare(revisioned);
    this.latestInspection = createFeaturePolicyInspection(revisioned, result.resolution);
    if (this.destroyed) return { status: 'failed', result: failedResult(result) };
    if (result.ok) {
      this.currentState = 'awaiting-publish';
      return { status: 'prepared', result };
    }
    this.currentState = 'idle';
    return { status: 'failed', result };
  }

  /** Publishes a prepared revision at the caller's frame boundary. */
  publishFrameBoundary(): FeaturePolicyPublication | undefined {
    this.assertActive();
    if (this.currentState !== 'awaiting-publish') return undefined;
    const publication = this.coordinator.publish();
    if (publication === undefined) {
      throw new Error('FeaturePolicy runtime lost its prepared publication.');
    }
    this.currentState = 'idle';
    return publication;
  }

  /** Releases all policies still owned by this runtime. This operation is idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.currentState = 'destroyed';
    this.coordinator.destroy();
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error('FeaturePolicyRuntimeController is destroyed.');
    }
  }
}

function failedResult(result: FeaturePolicyPrepareResult): FailedPrepareResult {
  if (!result.ok) return result;
  return {
    ok: false,
    resolution: result.resolution,
    error: new Error('FeaturePolicy runtime was destroyed during preparation.')
  };
}

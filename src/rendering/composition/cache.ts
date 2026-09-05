import type { FeaturePolicyCacheInvalidation } from '../../feature-policy';
import { FeaturePolicyCacheDomain } from '../../feature-policy/constants';
import { compileCompositionPlan } from './compiler';
import type { CompositionPlan, CompositionPlanCacheResult, CompositionPlanInput } from './types';

/** Caches only immutable plan templates; surface generation and policy identity are part of the key. */
export class CompositionPlanCache {
  private currentPlan: CompositionPlan | undefined;

  get current(): CompositionPlan | undefined {
    return this.currentPlan;
  }

  compile(input: CompositionPlanInput): CompositionPlanCacheResult {
    const next = compileCompositionPlan(input);
    if (this.currentPlan?.hash === next.hash) {
      return Object.freeze({ status: 'hit', plan: this.currentPlan });
    }
    this.currentPlan = next;
    return Object.freeze({ status: 'compiled', plan: next });
  }

  invalidate(invalidations: readonly FeaturePolicyCacheInvalidation[]): void {
    if (
      invalidations.some(
        (item) =>
          item.domain === FeaturePolicyCacheDomain.CompositionPlan &&
          item.previousHash === this.currentPlan?.policyHash
      )
    ) {
      this.currentPlan = undefined;
    }
  }
}

import { lowerBindingLayoutPlan } from './binding-layout-lowering';
import type {
  BindingLayoutPlan,
  LayoutCacheEntry,
  LayoutCacheMetrics,
  LayoutCacheRequest,
  LayoutCacheResolution
} from './types';

interface CanonicalPlanRecord {
  readonly plan: BindingLayoutPlan;
}

/** CPU-only cache for canonical binding plans and target-specific lowering descriptions. */
export class LayoutCache {
  private readonly canonicalPlans = new Map<string, CanonicalPlanRecord>();
  private readonly loweredEntries = new Map<string, LayoutCacheEntry>();
  private hitCount = 0;
  private missCount = 0;
  private invalidationCount = 0;

  /** Resolves or synchronously lowers descriptor data; this never creates an RHI object. */
  resolve(input: LayoutCacheRequest): LayoutCacheResolution {
    validateRequest(input);
    const existingPlan = this.canonicalPlans.get(input.plan.id);
    if (existingPlan !== undefined && existingPlan.plan.hash !== input.plan.hash)
      throw new Error(`Binding layout ID collision for ${input.plan.id}.`);
    const retainedPlan = existingPlan?.plan ?? input.plan;
    const key = JSON.stringify([
      retainedPlan.id,
      input.layoutRevision,
      input.featurePolicyHash,
      input.target,
      input.deviceGeneration
    ]);
    const existing = this.loweredEntries.get(key);
    if (existing !== undefined) {
      this.hitCount += 1;
      return Object.freeze({ status: 'hit', entry: existing });
    }
    const plan = existingPlan?.plan ?? snapshotPlan(input.plan);
    if (existingPlan === undefined) this.canonicalPlans.set(plan.id, { plan });
    const entry: LayoutCacheEntry = Object.freeze({
      plan,
      layoutRevision: input.layoutRevision,
      featurePolicyHash: input.featurePolicyHash,
      target: input.target,
      deviceGeneration: input.deviceGeneration,
      lowering: lowerBindingLayoutPlan(plan, input.target)
    });
    this.loweredEntries.set(key, entry);
    this.missCount += 1;
    return Object.freeze({ status: 'miss', entry });
  }

  /** Removes target-lowered entries from one lost device generation, retaining CPU plans. */
  invalidateDeviceGeneration(deviceGeneration: number): number {
    validateInteger(deviceGeneration, 'device generation');
    return this.invalidate((entry) => entry.deviceGeneration === deviceGeneration);
  }

  /** Removes target-lowered entries derived from one obsolete layout revision. */
  invalidateLayoutRevision(layoutRevision: number): number {
    validateInteger(layoutRevision, 'layout revision');
    return this.invalidate((entry) => entry.layoutRevision === layoutRevision);
  }

  /** Returns immutable structural counters without exposing internal maps. */
  metrics(): LayoutCacheMetrics {
    return Object.freeze({
      hits: this.hitCount,
      misses: this.missCount,
      invalidations: this.invalidationCount,
      canonicalPlans: this.canonicalPlans.size,
      loweredEntries: this.loweredEntries.size
    });
  }

  private invalidate(predicate: (entry: LayoutCacheEntry) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.loweredEntries) {
      if (!predicate(entry)) continue;
      this.loweredEntries.delete(key);
      removed += 1;
    }
    this.invalidationCount += removed;
    return removed;
  }
}

function snapshotPlan(input: BindingLayoutPlan): BindingLayoutPlan {
  const groups = input.groups.map((group) =>
    Object.freeze({
      group: group.group,
      visibility: Object.freeze([...group.visibility]),
      bindings: Object.freeze(group.bindings.map((binding) => Object.freeze({ ...binding })))
    })
  );
  return Object.freeze({
    id: input.id,
    shaderAbiVersion: input.shaderAbiVersion,
    groups: Object.freeze(groups),
    dynamicOffsetOrder: Object.freeze(
      input.dynamicOffsetOrder.map((value) => Object.freeze({ ...value }))
    ),
    backendRequirements: Object.freeze(
      input.backendRequirements.map((value) =>
        Object.freeze({
          ...value,
          ...('statuses' in value ? { statuses: Object.freeze([...value.statuses]) } : {})
        })
      )
    ),
    hash: input.hash
  });
}

function validateRequest(input: LayoutCacheRequest): void {
  if (typeof input?.plan?.id !== 'string' || !input.plan.id.trim())
    throw new Error('Layout cache plan ID must be non-empty.');
  if (typeof input.plan.hash !== 'string' || !input.plan.hash.trim())
    throw new Error('Layout cache plan hash must be non-empty.');
  if (typeof input.featurePolicyHash !== 'string' || !input.featurePolicyHash.trim())
    throw new Error('Layout cache FeaturePolicy hash must be non-empty.');
  if (input.target !== 'webgpu' && input.target !== 'webgl2')
    throw new Error('Layout cache target is invalid.');
  validateInteger(input.layoutRevision, 'layout revision');
  validateInteger(input.deviceGeneration, 'device generation');
}

function validateInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`Layout cache ${name} must be a non-negative integer.`);
}

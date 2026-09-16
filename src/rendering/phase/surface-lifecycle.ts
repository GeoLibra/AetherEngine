import { assertRenderGraphExecutionPlan, type RenderGraphExecutionPlan } from '../../render-graph';
import type {
  SurfaceRenderPlanContext,
  SurfaceRenderPlanResult,
  SurfaceRenderPlanRunInput
} from './types';

export type {
  SurfaceRenderPlanContext,
  SurfaceRenderPlanResult,
  SurfaceRenderPlanRunInput
} from './types';

interface CachedSurfacePlan {
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly plan: RenderGraphExecutionPlan;
}

/**
 * Reuses a compiled plan only while its surface configuration identity remains exact.
 *
 * Zero physical extent is resolved before graph construction or execution, ensuring a suspended
 * surface cannot reach acquisition or submission through the supplied executor callback.
 */
export class SurfaceRenderPlanCoordinator {
  private readonly plans = new Map<symbol, CachedSurfacePlan>();

  /**
   * Builds or reuses the current surface plan and executes it for a non-zero physical extent.
   *
   * @throws When the surface is not configured or exposes an invalid configuration generation.
   * @throws When `build` does not return a canonical RenderGraph execution plan.
   */
  run(input: SurfaceRenderPlanRunInput): SurfaceRenderPlanResult {
    const context = snapshotSurfaceContext(input);
    if (context.width === 0 || context.height === 0) {
      return Object.freeze({
        status: 'skipped',
        reason: 'surface-suspended',
        generation: context.generation
      });
    }

    const cached = this.plans.get(context.targetId);
    const hit = cached !== undefined && matches(cached, context);
    const plan = hit ? cached.plan : input.build(context);
    assertRenderGraphExecutionPlan(plan);
    if (!hit) {
      this.plans.set(
        context.targetId,
        Object.freeze({
          generation: context.generation,
          width: context.width,
          height: context.height,
          plan
        })
      );
    }
    input.execute(plan, context);
    return Object.freeze({
      status: 'rendered',
      cache: hit ? 'hit' : 'miss',
      generation: context.generation,
      width: context.width,
      height: context.height
    });
  }
}

function snapshotSurfaceContext(input: SurfaceRenderPlanRunInput): SurfaceRenderPlanContext {
  const { surface } = input;
  const configuration = surface.configuration;
  if (surface.state !== 'configured' || configuration === undefined) {
    throw new Error('Surface render plan coordination requires a configured surface.');
  }
  if (!Number.isSafeInteger(surface.generation) || surface.generation < 1) {
    throw new Error('Surface render plan coordination requires a positive surface generation.');
  }
  return Object.freeze({
    targetId: surface.target.id,
    generation: surface.generation,
    width: configuration.width,
    height: configuration.height
  });
}

function matches(cached: CachedSurfacePlan, context: SurfaceRenderPlanContext): boolean {
  return (
    cached.generation === context.generation &&
    cached.width === context.width &&
    cached.height === context.height
  );
}

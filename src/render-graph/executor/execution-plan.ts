import type { GraphPassDeclaration, RenderGraphSnapshot } from '../builder/builder';
import {
  isCompiledRenderGraph,
  isCompiledRenderGraphForSnapshot,
  partitionRasterGroups,
  analyzeResourceLifetimes,
  planResourceAliases,
  derivePortableTransitions
} from '../compiler';
import type {
  CompiledRenderGraph,
  PassFusionOptions,
  RasterGroupPlan,
  RenderGraphExecutionPlan,
  RenderGraphExecutionStep,
  ResourceAliasPlan
} from '../types';
import { validatePhysicalTransitionsAndPassBoundaries } from './executor-physical-validation';

export type { RenderGraphExecutionPlan, RenderGraphExecutionStep } from '../types';

const CANONICAL_EXECUTION_PLANS = new WeakSet<object>();

export interface ExecutionPlanOptions extends PassFusionOptions {
  readonly submissionIndex?: number;
}

export function createRenderGraphExecutionPlan(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  options?: ExecutionPlanOptions
): RenderGraphExecutionPlan {
  if (!isCompiledRenderGraphForSnapshot(compiled, snapshot)) {
    throw nonCanonical('compiled graph provenance does not match the snapshot');
  }
  const partition = partitionRasterGroups(snapshot, compiled, options);
  const transitions = derivePortableTransitions(snapshot, compiled, {
    submissionIndex: options?.submissionIndex ?? 0
  });
  const plan = Object.freeze({
    snapshot,
    compiled,
    aliases: planResourceAliases(
      snapshot,
      analyzeResourceLifetimes(snapshot, compiled, partition.groups)
    ),
    schedule: createRenderGraphExecutionSchedule(compiled, partition.groups),
    rasterGroups: partition.groups,
    fusion: partition,
    transitions
  });
  validatePhysicalTransitionsAndPassBoundaries(plan);
  CANONICAL_EXECUTION_PLANS.add(plan);
  return plan;
}

export function createRenderGraphExecutionSchedule(
  compiled: CompiledRenderGraph,
  groups: readonly RasterGroupPlan[] = []
): readonly RenderGraphExecutionStep[] {
  const steps: RenderGraphExecutionStep[] = [Object.freeze({ kind: 'prelude' as const })];

  const passToGroup = new Map<number, { group: RasterGroupPlan; isFirst: boolean }>();
  for (const group of groups) {
    for (let i = 0; i < group.retainedPassIndices.length; i++) {
      passToGroup.set(group.retainedPassIndices[i]!, { group, isFirst: i === 0 });
    }
  }

  for (let retainedPassIndex = 0; retainedPassIndex < compiled.order.length; retainedPassIndex++) {
    const passId = compiled.order[retainedPassIndex]!;
    const groupInfo = passToGroup.get(retainedPassIndex);
    if (groupInfo !== undefined) {
      if (groupInfo.isFirst) {
        steps.push(
          Object.freeze({
            kind: 'raster-group' as const,
            groupIndex: groupInfo.group.groupIndex
          })
        );
      }
    } else {
      steps.push(
        Object.freeze({
          kind: 'pass' as const,
          passId,
          retainedPassIndex
        })
      );
    }
  }

  steps.push(Object.freeze({ kind: 'submission' as const }));
  return Object.freeze(steps);
}

/** Rejects erased or JavaScript callers that attempt to pass an absent/rebuilt frame product. */
export function assertRenderGraphExecutionPlan(
  value: unknown
): asserts value is RenderGraphExecutionPlan {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('snapshot' in value) ||
    !('compiled' in value) ||
    !('aliases' in value) ||
    !('schedule' in value) ||
    !('rasterGroups' in value) ||
    !('fusion' in value) ||
    !('transitions' in value) ||
    !Array.isArray(value.transitions) ||
    !Array.isArray(value.schedule) ||
    !CANONICAL_EXECUTION_PLANS.has(value)
  ) {
    throw new Error('Render frame stages must return a compiled render graph plan.');
  }
}

export function validateRenderGraphExecutionPlan(plan: RenderGraphExecutionPlan): void {
  if (!CANONICAL_EXECUTION_PLANS.has(plan)) {
    throw nonCanonical('plan provenance was not created by the RenderGraph compiler boundary');
  }
  if (!isCompiledRenderGraph(plan.compiled)) {
    throw nonCanonical('compiled graph provenance was not created by the RenderGraph compiler');
  }
  if (!isCompiledRenderGraphForSnapshot(plan.compiled, plan.snapshot)) {
    throw nonCanonical('compiled graph provenance does not match the exact snapshot');
  }
  if (plan.snapshot.graphId !== plan.compiled.graphId) {
    throw nonCanonical('graph id does not match the compiled graph');
  }
  const snapshotPasses = new Set(plan.snapshot.passes);
  const retainedPasses = plan.compiled.retainedPasses;
  if (plan.compiled.order.length !== retainedPasses.length) {
    throw nonCanonical('compiled order and retained pass counts differ');
  }
  for (
    let retainedPassIndex = 0;
    retainedPassIndex < retainedPasses.length;
    retainedPassIndex += 1
  ) {
    const pass = retainedPasses[retainedPassIndex];
    const passId = plan.compiled.order[retainedPassIndex];
    if (pass === undefined || passId !== pass.token.passId) {
      throw nonCanonical('compiled order does not exactly match retained pass ids');
    }
    if (!snapshotPasses.has(pass)) {
      throw nonCanonical('retained pass is absent from the graph snapshot');
    }
  }

  if (!Array.isArray(plan.schedule) || plan.schedule.length < 2) {
    throw nonCanonical('schedule must have at least prelude and submission steps');
  }
  if (plan.schedule[0]?.kind !== 'prelude') {
    throw nonCanonical('schedule must begin with prelude');
  }
  if (plan.schedule[plan.schedule.length - 1]?.kind !== 'submission') {
    throw nonCanonical('schedule must end with submission');
  }

  const groups = plan.rasterGroups ?? [];
  if (plan.fusion.groups !== plan.rasterGroups) {
    throw nonCanonical('fusion groups do not match the physical raster group schedule');
  }
  const groupById = new Map<number, RasterGroupPlan>();
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group.groupIndex !== i) {
      throw nonCanonical('raster group index is not sequential');
    }
    groupById.set(group.groupIndex, group);
  }

  const referencedGroups = new Set<number>();
  const visitedRetainedIndices: number[] = [];

  for (let i = 1; i < plan.schedule.length - 1; i++) {
    if (!Object.hasOwn(plan.schedule, i)) {
      throw nonCanonical('schedule contains a sparse step');
    }
    const step = plan.schedule[i]!;
    if (step.kind === 'raster-group') {
      const group = groupById.get(step.groupIndex);
      if (group === undefined) {
        throw nonCanonical(`schedule references unknown raster group ${step.groupIndex}`);
      }
      if (referencedGroups.has(step.groupIndex)) {
        throw nonCanonical(`raster group ${step.groupIndex} referenced multiple times in schedule`);
      }
      referencedGroups.add(step.groupIndex);
      for (const passIdx of group.retainedPassIndices) {
        visitedRetainedIndices.push(passIdx);
      }
    } else if (step.kind === 'pass') {
      const pass = retainedPasses[step.retainedPassIndex];
      if (pass === undefined || step.passId !== pass.token.passId) {
        throw nonCanonical('schedule pass does not match its retained pass index');
      }
      visitedRetainedIndices.push(step.retainedPassIndex);
    } else {
      throw nonCanonical('unknown step kind in schedule');
    }
  }

  if (referencedGroups.size !== groups.length) {
    throw nonCanonical('not all raster groups were scheduled');
  }

  if (visitedRetainedIndices.length !== retainedPasses.length) {
    throw nonCanonical('scheduled passes count does not match retained passes');
  }

  for (let i = 0; i < retainedPasses.length; i++) {
    if (visitedRetainedIndices[i] !== i) {
      throw nonCanonical('scheduled passes do not reproduce compiled order exactly');
    }
  }

  if (!Array.isArray(plan.transitions)) {
    throw nonCanonical('plan transitions must be an array');
  }
  validatePhysicalTransitionsAndPassBoundaries(plan);
}

export function requiredScheduledPass(
  compiled: CompiledRenderGraph,
  step: Extract<RenderGraphExecutionStep, { readonly kind: 'pass' }>
): GraphPassDeclaration {
  const pass = compiled.retainedPasses[step.retainedPassIndex];
  if (pass === undefined || pass.token.passId !== step.passId) {
    throw nonCanonical('scheduled pass cannot be resolved by retained pass index');
  }
  return pass;
}

export function requiredRasterGroup(
  plan: RenderGraphExecutionPlan,
  step: Extract<RenderGraphExecutionStep, { readonly kind: 'raster-group' }>
): RasterGroupPlan {
  const group = plan.rasterGroups?.[step.groupIndex];
  if (group === undefined || group.groupIndex !== step.groupIndex) {
    throw nonCanonical('scheduled raster group cannot be resolved by group index');
  }
  return group;
}

function nonCanonical(reason: string): Error {
  return new Error(
    `Render graph execution plan is not a canonical render graph execution plan: ${reason}.`
  );
}

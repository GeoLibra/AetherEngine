import type { GraphPassDeclaration, RenderGraphSnapshot } from '../builder/builder';
import { isCompiledRenderGraph, isCompiledRenderGraphForSnapshot } from '../compiler/compiler';
import {
  analyzeResourceLifetimes,
  planResourceAliases,
  type ResourceAliasPlan
} from '../compiler/lifetimes';
import type {
  CompiledRenderGraph,
  RenderGraphExecutionPlan,
  RenderGraphExecutionStep
} from '../types';

export type { RenderGraphExecutionPlan, RenderGraphExecutionStep } from '../types';

const CANONICAL_EXECUTION_PLANS = new WeakSet<object>();

export function createRenderGraphExecutionPlan(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph
): RenderGraphExecutionPlan {
  if (!isCompiledRenderGraphForSnapshot(compiled, snapshot)) {
    throw nonCanonical('compiled graph provenance does not match the snapshot');
  }
  const plan = Object.freeze({
    snapshot,
    compiled,
    aliases: planResourceAliases(snapshot, analyzeResourceLifetimes(snapshot, compiled)),
    schedule: createRenderGraphExecutionSchedule(compiled)
  });
  CANONICAL_EXECUTION_PLANS.add(plan);
  return plan;
}

export function createRenderGraphExecutionSchedule(
  compiled: CompiledRenderGraph
): readonly RenderGraphExecutionStep[] {
  return Object.freeze([
    Object.freeze({ kind: 'prelude' as const }),
    ...compiled.order.map((passId, retainedPassIndex) =>
      Object.freeze({ kind: 'pass' as const, passId, retainedPassIndex })
    ),
    Object.freeze({ kind: 'submission' as const })
  ]);
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
  const expectedLength = retainedPasses.length + 2;
  if (!Array.isArray(plan.schedule) || plan.schedule.length !== expectedLength) {
    throw nonCanonical('schedule length does not match retained passes');
  }
  for (let scheduleIndex = 0; scheduleIndex < expectedLength; scheduleIndex += 1) {
    if (!Object.hasOwn(plan.schedule, scheduleIndex)) {
      throw nonCanonical('schedule contains a sparse step');
    }
    const step = plan.schedule[scheduleIndex];
    if (scheduleIndex === 0) {
      if (step?.kind !== 'prelude') throw nonCanonical('schedule must begin with prelude');
      continue;
    }
    if (scheduleIndex === expectedLength - 1) {
      if (step?.kind !== 'submission') throw nonCanonical('schedule must end with submission');
      continue;
    }
    const retainedPassIndex = scheduleIndex - 1;
    const pass = retainedPasses[retainedPassIndex];
    if (
      step?.kind !== 'pass' ||
      pass === undefined ||
      step.passId !== pass.token.passId ||
      step.retainedPassIndex !== retainedPassIndex
    ) {
      throw nonCanonical('schedule pass does not match its retained pass index');
    }
  }
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

function nonCanonical(reason: string): Error {
  return new Error(
    `Render graph execution plan is not a canonical render graph execution plan: ${reason}.`
  );
}

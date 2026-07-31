import type { GraphPassDeclaration, RenderGraphSnapshot } from './builder';
import type { CompiledRenderGraph } from './compiler';

/** Compiler-owned lifecycle boundaries and retained pass invocations for one graph submission. */
export type RenderGraphExecutionStep =
  | { readonly kind: 'prelude' }
  | { readonly kind: 'pass'; readonly passId: number; readonly retainedPassIndex: number }
  | { readonly kind: 'submission' };

/** The only executable representation accepted by the frame and RHI execution seams. */
export interface RenderGraphExecutionPlan {
  readonly snapshot: RenderGraphSnapshot;
  readonly compiled: CompiledRenderGraph;
  readonly schedule: readonly RenderGraphExecutionStep[];
}

export function createRenderGraphExecutionPlan(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph
): RenderGraphExecutionPlan {
  return Object.freeze({
    snapshot,
    compiled,
    schedule: createRenderGraphExecutionSchedule(compiled)
  });
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
    !('schedule' in value) ||
    !Array.isArray(value.schedule)
  ) {
    throw new Error('Render frame stages must return a compiled render graph plan.');
  }
}

export function validateRenderGraphExecutionPlan(plan: RenderGraphExecutionPlan): void {
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

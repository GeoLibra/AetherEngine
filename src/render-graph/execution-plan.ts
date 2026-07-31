import type { GraphPassDeclaration, RenderGraphSnapshot } from './builder';
import type { CompiledRenderGraph } from './compiler';

/** Compiler-owned lifecycle boundaries and retained pass invocations for one graph submission. */
export type RenderGraphExecutionStep =
  | { readonly kind: 'prelude' }
  | { readonly kind: 'pass'; readonly passId: number }
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
    ...compiled.order.map((passId) => Object.freeze({ kind: 'pass' as const, passId })),
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
    throw new Error('Render graph execution plan graph id does not match its compiled schedule.');
  }
  const snapshotPasses = new Set(plan.snapshot.passes);
  for (const pass of plan.compiled.retainedPasses) {
    if (!snapshotPasses.has(pass)) {
      throw new Error('Render graph execution plan references an unknown pass.');
    }
  }
  const expected = createRenderGraphExecutionSchedule(plan.compiled);
  if (
    plan.schedule.length !== expected.length ||
    plan.schedule.some(
      (step, index) =>
        step.kind !== expected[index]?.kind ||
        (step.kind === 'pass' &&
          (expected[index]?.kind !== 'pass' || step.passId !== expected[index].passId))
    )
  ) {
    throw new Error('Render graph execution plan schedule does not match its compiled graph.');
  }
}

export function requiredScheduledPass(
  compiled: CompiledRenderGraph,
  step: Extract<RenderGraphExecutionStep, { readonly kind: 'pass' }>
): GraphPassDeclaration {
  const pass = compiled.retainedPasses.find((candidate) => candidate.token.passId === step.passId);
  if (pass === undefined) {
    throw new Error('Render graph execution schedule references an unknown pass.');
  }
  return pass;
}

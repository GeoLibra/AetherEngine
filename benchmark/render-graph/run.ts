import { createReferenceRenderGraphScenario } from './scenarios';
import type { RenderGraphReferenceResult } from './types';

const REFERENCE_SCENARIO_INPUT = Object.freeze({
  seed: 13,
  passCount: 16,
  resourceCount: 32,
  accessDensity: 0.25
});

export function runRenderGraphReferenceScenario(): RenderGraphReferenceResult {
  return createReferenceRenderGraphScenario(REFERENCE_SCENARIO_INPUT).runReference();
}

if (process.env.AETHER_RENDER_GRAPH_BENCH_PROFILE !== undefined) {
  process.stdout.write(`${JSON.stringify(runRenderGraphReferenceScenario())}\n`);
}

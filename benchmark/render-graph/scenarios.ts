import { createRenderGraphWorkload } from './fixtures';
import { runReferenceRenderGraph } from './reference';
import type { RenderGraphScenario, RenderGraphWorkloadOptions } from './types';

export function createReferenceRenderGraphScenario(
  options: RenderGraphWorkloadOptions
): RenderGraphScenario {
  const workload = createRenderGraphWorkload(options);
  return Object.freeze({
    scenarioId: 'hazard-compile-v1',
    scenarioVersion: 1,
    workload,
    runReference: () => runReferenceRenderGraph(workload)
  });
}

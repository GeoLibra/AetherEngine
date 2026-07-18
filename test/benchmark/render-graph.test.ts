import { describe, expect, test } from 'vitest';
import { createRenderGraphWorkload } from '../../benchmark/render-graph/fixtures';
import { runReferenceRenderGraph } from '../../benchmark/render-graph/reference';

describe('render graph benchmark oracle', () => {
  test('is deterministic for the same versioned seed', () => {
    const input = { seed: 13, passCount: 16, resourceCount: 32, accessDensity: 0.25 } as const;

    expect(runReferenceRenderGraph(createRenderGraphWorkload(input))).toEqual(
      runReferenceRenderGraph(createRenderGraphWorkload(input))
    );
  });
});

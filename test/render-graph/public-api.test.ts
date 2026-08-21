import { describe, expect, test } from 'vitest';
// @ts-expect-error Restricted shader state is an internal RenderGraph implementation detail.
import type { RestrictedFragmentState as RootRestrictedFragmentState } from '../../src';
// @ts-expect-error Restricted shader state is not part of the RenderGraph public barrel.
import type { RestrictedFragmentState as BarrelRestrictedFragmentState } from '../../src/render-graph';
// @ts-expect-error Restricted programmable stages are internal lowering contracts.
import type { RestrictedProgrammableStage as RootRestrictedProgrammableStage } from '../../src';
// @ts-expect-error Restricted programmable stages are not exported from the public barrel.
import type { RestrictedProgrammableStage as BarrelRestrictedProgrammableStage } from '../../src/render-graph';
// @ts-expect-error Restricted vertex state is an internal lowering contract.
import type { RestrictedVertexState as RootRestrictedVertexState } from '../../src';
// @ts-expect-error Restricted vertex state is not exported from the public barrel.
import type { RestrictedVertexState as BarrelRestrictedVertexState } from '../../src/render-graph';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderGraph,
  compileRenderSystems,
  createPreparedBindGroupLayoutToken,
  createPreparedComputePipelineToken,
  createPreparedRenderPipelineToken,
  renderSystemToken
} from '../../src';
import { RenderSystemRegistry as RenderingRenderSystemRegistry } from '../../src/rendering';

describe('RenderGraph public API', () => {
  test('exports direct graph and RenderSystem facade entry points from the package', () => {
    expect(RenderGraphBuilder).toBeTypeOf('function');
    expect(RenderGraphExecutor).toBeTypeOf('function');
    expect(RenderSystemRegistry).toBeTypeOf('function');
    expect(compileRenderGraph).toBeTypeOf('function');
    expect(compileRenderSystems).toBeTypeOf('function');
    expect(createPreparedRenderPipelineToken('main')).toMatchObject({
      kind: 'prepared-render-pipeline-token',
      name: 'main'
    });
    expect(createPreparedComputePipelineToken('light-list')).toMatchObject({
      kind: 'prepared-compute-pipeline-token',
      name: 'light-list'
    });
    expect(createPreparedBindGroupLayoutToken('light-list-layout')).toMatchObject({
      kind: 'prepared-bind-group-layout-token',
      name: 'light-list-layout'
    });
    expect(renderSystemToken('example').id).toBe('example');
    expect(RenderingRenderSystemRegistry).toBe(RenderSystemRegistry);
  });
});

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
// @ts-expect-error Legacy opaque callback context is removed.
import type { RestrictedPassContext as RootRestrictedPassContext } from '../../src';
// @ts-expect-error Legacy opaque callback context is not exported from the public barrel.
import type { RestrictedPassContext as BarrelRestrictedPassContext } from '../../src/render-graph';
// @ts-expect-error Legacy encoder type is removed.
import type { RestrictedRenderPassEncoder as RootRestrictedRenderPassEncoder } from '../../src';
// @ts-expect-error Legacy encoder type is not exported from the public barrel.
import type { RestrictedRenderPassEncoder as BarrelRestrictedRenderPassEncoder } from '../../src/render-graph';
// @ts-expect-error Legacy encoder type is removed.
import type { RestrictedComputePassEncoder as RootRestrictedComputePassEncoder } from '../../src';
// @ts-expect-error Legacy encoder type is not exported from the public barrel.
import type { RestrictedComputePassEncoder as BarrelRestrictedComputePassEncoder } from '../../src/render-graph';
// @ts-expect-error Legacy declared raster pass descriptor is removed.
import type { DeclaredRasterPass as RootDeclaredRasterPass } from '../../src';
// @ts-expect-error Legacy declared raster pass descriptor is not exported from the public barrel.
import type { DeclaredRasterPass as BarrelDeclaredRasterPass } from '../../src/render-graph';
// @ts-expect-error PreparedDrawResourceBindings singular alias is removed in favor of PreparedDrawResourcesBindings.
import type { PreparedDrawResourceBindings as RootPreparedDrawResourceBindings } from '../../src';
// @ts-expect-error PreparedDrawResourceBindings singular alias is not exported from the render-graph barrel.
import type { PreparedDrawResourceBindings as BarrelPreparedDrawResourceBindings } from '../../src/render-graph';
import type {
  RasterPassContext,
  ComputePassContext,
  CopyPassContext,
  RasterCommands,
  ComputeCommands,
  CopyCommands
} from '../../src';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderGraph,
  compileRenderSystems,
  createPreparedComputePipelineToken,
  createPreparedRenderPipelineToken,
  renderSystemToken
} from '../../src';
import { RenderSystemRegistry as RenderingRenderSystemRegistry } from '../../src/rendering';
import * as renderGraphApi from '../../src/render-graph';

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
    expect(renderSystemToken('example').id).toBe('example');
    expect(RenderingRenderSystemRegistry).toBe(RenderSystemRegistry);
  });

  test('does not publish executor and restricted-context implementation helpers', () => {
    expect(Object.keys(renderGraphApi)).not.toEqual(
      expect.arrayContaining([
        'PassBuilderState',
        'RestrictedContext',
        'RestrictedResourceOwner',
        'allocationFor',
        'resolveResources',
        'safelyReleaseFrame'
      ])
    );
  });

  test('does not publish compiler schedule, topology and fusion internal helpers', () => {
    expect(Object.keys(renderGraphApi)).not.toEqual(
      expect.arrayContaining([
        'sortPassDeclarations',
        'detectCycles',
        'cullUnusedPasses',
        'validatePassDeclarations',
        'evaluateCandidateFusion',
        'summarizeFusionResidency',
        'evaluateResidencyBudget',
        'lowerPhysicalAttachmentOperations',
        'compareColorSignatures',
        'compareExistingDepthSignatures',
        'extractRasterSignature',
        'rasterSignatureMatches',
        'GroupUsageAccumulator',
        'createFusionDiagnostics'
      ])
    );
  });
});

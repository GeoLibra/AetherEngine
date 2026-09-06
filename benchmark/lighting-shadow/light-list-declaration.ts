import {
  RenderGraphBuilder,
  ZERO_RESOURCE_BUDGET,
  createPreparedRenderPipelineToken,
  createWebGlFragmentLightListImplementation
} from '../../src';
import { packWebGpuLightListInput, type RenderEntityId } from '../../src';

const CAPACITY = Object.freeze({
  maxDirectionalLights: 16,
  maxLightsPerReceiver: 64,
  maxLightIndices: 65_536
});
const IMPLEMENTATION = createWebGlFragmentLightListImplementation({
  capacity: CAPACITY,
  estimatedBudget: ZERO_RESOURCE_BUDGET,
  maxTextureDimension2D: 8192
});
const PIPELINE = createPreparedRenderPipelineToken('benchmark-light-list');

export interface LightListDeclarationObservation {
  readonly receiverCount: number;
  readonly passCount: number;
  readonly resourceCount: number;
}

export function createLightListPackingWorkload(count: number) {
  const lights = Array.from({ length: count }, (_, index) => ({
    entity: index as RenderEntityId,
    payloadVersion: 1,
    kind: 'point' as const,
    position: [index % 97, 0, 0] as const,
    luminousIntensityCandela: 1,
    range: 4,
    colorLinear: [1, 1, 1] as const,
    enabled: true,
    layerMask: 1,
    castsShadow: false
  }));
  const receivers = Array.from({ length: count }, (_, index) => ({
    renderEntity: index as RenderEntityId,
    layerMask: 1,
    bounds: { kind: 'sphere' as const, center: [index % 97, 0, 0] as const, radius: 1 }
  }));
  return Object.freeze({ viewLayerMask: 1, lights, receivers, capacity: CAPACITY });
}

export function packLightListBenchmarkInput(
  workload: ReturnType<typeof createLightListPackingWorkload>
) {
  return packWebGpuLightListInput(workload);
}

/** Declares the fixed-cost WebGL2 light-list graph seam for benchmark measurement. */
export function declareLightListBenchmarkGraph(
  receiverCount: number
): LightListDeclarationObservation {
  const graph = new RenderGraphBuilder();
  let inputIndex = 0;
  const inputTexture = () =>
    graph.createTexture(
      {
        width: 1,
        height: 1,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        format: 'rgba32uint',
        usage: ['sampled']
      },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: `benchmark-input-${inputIndex++}` }
        }
      }
    );
  IMPLEMENTATION.contribute(CAPACITY, {
    graph,
    viewId: 'benchmark-view',
    input: { lights: inputTexture(), receivers: inputTexture(), receiverCount },
    recorder: { pipeline: PIPELINE, record: () => undefined },
    publish: () => undefined
  });
  const snapshot = graph.build();
  return Object.freeze({
    receiverCount,
    passCount: snapshot.passes.length,
    resourceCount: snapshot.resources.length
  });
}

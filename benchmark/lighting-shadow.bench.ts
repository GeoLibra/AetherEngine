import { bench, expect } from 'vitest';
import {
  createLightingWorkload,
  createShadowSelectionWorkload,
  runLightingReference,
  runLightingSubject,
  runShadowAtlasCompactionReference,
  runShadowAtlasCompactionSubject,
  runShadowAtlasReference,
  runShadowAtlasSubject,
  runShadowSelectionReference,
  runShadowSelectionSubject
} from './lighting-shadow/scenario';
import { RenderGraphBuilder } from '../src/render-graph';
import {
  createPreparedRenderPipelineToken,
  createWebGlFragmentLightListImplementation,
  declareShadowDepthPasses,
  ZERO_RESOURCE_BUDGET
} from '../src';
import { ReadonlyMapSnapshot } from '../src/rendering/world/readonly-collection-snapshot';
import {
  assertDeclaredShadowLayers,
  createShadowDeclarationWorkload
} from './lighting-shadow/declaration-scenario';

for (const count of [100, 1_000, 10_000]) {
  const workload = createShadowSelectionWorkload(count);
  const reference = runShadowSelectionReference(workload);
  bench(
    `shadow request selection ${count} requests`,
    () => expect(runShadowSelectionSubject(workload)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const receiverCount of [100, 1_000, 10_000]) {
  const workload = createLightingWorkload(receiverCount, 32, 71);
  const reference = runLightingReference(workload);
  bench(
    `CPU light list ${receiverCount} receivers x 32 lights`,
    () => {
      const subject = runLightingSubject(workload);
      expect(subject).toEqual(reference);
      expect(subject.counters.candidatePairs).toBeGreaterThan(0);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const constrained = createLightingWorkload(1_000, 128, 97, true);
const constrainedReference = runLightingReference(constrained);
bench(
  'CPU light list constrained overflow 1000 receivers x 128 lights',
  () => {
    const subject = runLightingSubject(constrained);
    expect(subject).toEqual(constrainedReference);
    expect(subject.counters.truncatedIndices).toBeGreaterThan(0);
  },
  { iterations: 1, warmupIterations: 0 }
);

const preparedWebGlLightList = Object.freeze({
  maxDirectionalLights: 16,
  maxLightsPerReceiver: 64,
  maxLightIndices: 65_536
});
const webGlLightList = createWebGlFragmentLightListImplementation({
  capacity: preparedWebGlLightList,
  estimatedBudget: ZERO_RESOURCE_BUDGET,
  maxTextureDimension2D: 8192
});
const benchmarkLightListPipeline = createPreparedRenderPipelineToken('benchmark-light-list');
for (const receiverCount of [100, 10_000, 1_000_000]) {
  bench(
    `declare WebGL2 light-list graph for ${receiverCount} receivers`,
    () => {
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
      webGlLightList.contribute(preparedWebGlLightList, {
        graph,
        viewId: 'benchmark-view',
        input: { lights: inputTexture(), receivers: inputTexture(), receiverCount },
        recorder: {
          pipeline: benchmarkLightListPipeline,
          record: () => undefined
        },
        publish: () => undefined
      });
      const snapshot = graph.build();
      expect(snapshot.passes).toHaveLength(1);
      expect(snapshot.resources).toHaveLength(6);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const count of [16, 64, 256]) {
  const reference = runShadowAtlasCompactionReference(count, 16);
  bench(
    `shadow atlas compaction ${count} uniform tiles`,
    () => {
      const subject = runShadowAtlasCompactionSubject(count, 16);
      expect(subject).toEqual(reference);
      expect(subject.counters.relocations).toBe(count);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const atlasReference = runShadowAtlasReference(32, 32, 32);
bench(
  'shadow atlas allocation and lower-hole reclamation for 1024 uniform tiles',
  () => {
    expect(runShadowAtlasSubject(32, 32, 32)).toEqual(atlasReference);
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const count of [16, 64, 256]) {
  const declarationWorkload = createShadowDeclarationWorkload(count);
  const { requests } = declarationWorkload;
  const entries = new Map(requests.map((request, index) => [`key-${index}`, index] as const));
  bench(
    `constructs ${count} shadow ReadonlyMapSnapshot entries`,
    () => {
      const snapshot = new ReadonlyMapSnapshot(entries);
      expect(snapshot.size).toBe(count);
      expect(snapshot.get(`key-${count - 1}`)).toBe(count - 1);
    },
    { iterations: 1, warmupIterations: 0 }
  );
  bench(
    `declares ${count} shadow layers with an immutable request map`,
    () => {
      const graph = new RenderGraphBuilder();
      const declaration = declareShadowDepthPasses(graph, requests, { record: () => undefined });
      expect(declaration.passes).toHaveLength(count);
      expect(declaration.layerByRequestKey.size).toBe(count);
      expect(
        assertDeclaredShadowLayers(declarationWorkload, declaration.layerByRequestKey)
      ).toEqual(declarationWorkload.expectedLayers);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

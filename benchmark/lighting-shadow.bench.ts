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
  LIGHT_LIST_HEADER_WORDS,
  LIGHT_LIST_LIGHT_WORDS,
  LIGHT_LIST_RECEIVER_WORDS,
  declareShadowDepthPasses
} from '../src';
import { ReadonlyMapSnapshot } from '../src/rendering/world/readonly-collection-snapshot';
import {
  assertDeclaredShadowLayers,
  createShadowDeclarationWorkload
} from './lighting-shadow/declaration-scenario';
import {
  declareLightListBenchmarkGraph,
  createLightListPackingWorkload,
  packLightListBenchmarkInput
} from './lighting-shadow/light-list-declaration';

for (const count of [100, 1_000, 10_000]) {
  const workload = createShadowSelectionWorkload(count);
  const reference = runShadowSelectionReference(workload);
  bench(
    `shadow request selection ${count} requests`,
    () => expect(runShadowSelectionSubject(workload)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const count of [16, 64, 256]) {
  const workload = createLightListPackingWorkload(count);
  bench(`pack WebGPU light-list ABI for ${count} lights and receivers`, () => {
    const packed = packLightListBenchmarkInput(workload);
    expect(packed.lights.length).toBe(LIGHT_LIST_HEADER_WORDS + count * LIGHT_LIST_LIGHT_WORDS);
    expect(packed.receivers.length).toBe(
      LIGHT_LIST_HEADER_WORDS + count * LIGHT_LIST_RECEIVER_WORDS
    );
  });
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

for (const receiverCount of [100, 10_000, 1_000_000]) {
  bench(
    `declare WebGL2 light-list graph for ${receiverCount} receivers`,
    () => {
      const observation = declareLightListBenchmarkGraph(receiverCount);
      expect(observation.passCount).toBe(1);
      expect(observation.resourceCount).toBe(6);
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

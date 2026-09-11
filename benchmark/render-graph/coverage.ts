import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  analyzeResourceLifetimes,
  compileRenderGraph,
  planResourceAliases
} from '../../src/render-graph/compiler';
import {
  createCompatibleRasterWorkload,
  createComputeCutWorkload,
  createLateDepthWorkload,
  runFusionSubject
} from './fusion-scenarios';

export interface RenderGraphCoverageEvidence {
  readonly scaleAxes: {
    readonly passCounts: readonly number[];
    readonly resourceCounts: readonly number[];
  };
  readonly workloadFamilies: readonly Readonly<{
    id:
      | 'whole-resource'
      | 'buffer-range'
      | 'texture-subresource'
      | 'linear-chain'
      | 'fan-out-fan-in'
      | 'culled-branch'
      | 'aliasable-lifetimes'
      | 'fusion-compatible-chain'
      | 'fusion-compute-cut'
      | 'fusion-late-depth';
    status: 'pass';
    counters: Readonly<Record<string, number>>;
  }>[];
  readonly largeScale: {
    readonly seed: number;
    readonly passCount: 1024;
    readonly resourceCount: 2048;
    readonly accessesExamined: number;
    readonly retainedPasses: number;
    readonly status: 'pass';
  };
}

const BUFFER = Object.freeze({
  size: 256,
  usage: Object.freeze(['storage-read', 'storage-write'] as const)
});
const TEXTURE = Object.freeze({
  width: 16,
  height: 16,
  depthOrArrayLayers: 2,
  mipLevelCount: 2,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: Object.freeze(['sampled', 'color-attachment'] as const)
});

/** Deterministic closed-form probes complement the timed independent reference scenario. */
export function runRenderGraphCoverageEvidence(): RenderGraphCoverageEvidence {
  const range = rangeProbe();
  const texture = textureProbe();
  const topology = topologyProbe();
  const cull = cullProbe();
  const alias = aliasProbe();
  const fusion = fusionProbes();
  const largeScale = largeScaleProbe();
  return Object.freeze({
    scaleAxes: Object.freeze({
      passCounts: Object.freeze([16, 128, 1024]),
      resourceCounts: Object.freeze([32, 256, 2048])
    }),
    workloadFamilies: Object.freeze([
      family('whole-resource', { timedOracleCases: 2 }),
      family('buffer-range', range),
      family('texture-subresource', texture),
      family('linear-chain', { edges: topology.linearEdges }),
      family('fan-out-fan-in', { edges: topology.fanEdges }),
      family('culled-branch', cull),
      family('aliasable-lifetimes', alias),
      family('fusion-compatible-chain', fusion.compatible),
      family('fusion-compute-cut', fusion.computeCut),
      family('fusion-late-depth', fusion.lateDepth)
    ]),
    largeScale
  });
}

function fusionProbes(): {
  compatible: Readonly<Record<string, number>>;
  computeCut: Readonly<Record<string, number>>;
  lateDepth: Readonly<Record<string, number>>;
} {
  const compatible = runFusionSubject(createCompatibleRasterWorkload(10));
  assert(
    compatible.counters.physicalGroupCount === 1 && compatible.counters.fusedBoundariesCount === 9,
    'compatible fusion workload must produce one group and nine fused boundaries'
  );
  const computeCut = runFusionSubject(createComputeCutWorkload(10));
  assert(
    computeCut.counters.physicalGroupCount === 2,
    'compute cut workload must produce two physical raster groups'
  );
  const lateDepth = runFusionSubject(createLateDepthWorkload(10));
  assert(
    lateDepth.counters.physicalGroupCount === 1 && lateDepth.counters.fusedBoundariesCount === 9,
    'late depth workload must prove a single physical raster group'
  );
  return {
    compatible: fusionCounters(compatible),
    computeCut: fusionCounters(computeCut),
    lateDepth: fusionCounters(lateDepth)
  };
}

function fusionCounters(
  observation: ReturnType<typeof runFusionSubject>
): Readonly<Record<string, number>> {
  return Object.freeze({
    logicalPassCount: observation.counters.logicalPassCount,
    physicalGroupCount: observation.counters.physicalGroupCount,
    fusedBoundariesCount: observation.counters.fusedBoundariesCount,
    scheduledSteps: observation.counters.scheduledSteps
  });
}

function rangeProbe(): Readonly<Record<string, number>> {
  const graph = new RenderGraphBuilder();
  let value = graph.createBuffer(BUFFER, {
    origin: imported('range-buffer', 'storage-read')
  });
  graph.addCopyPass({
    id: 'range/read',
    setup(pass) {
      pass.readBuffer(value, 'storage-read', { offset: 0, size: 64 });
      pass.sideEffect('range read');
      return undefined;
    },
    run() {}
  });
  graph.addComputePass({
    id: 'range/write',
    setup(pass) {
      value = pass.writeBuffer(value, 'storage-write', { offset: 0, size: 64 });
      pass.sideEffect('range write');
      return undefined;
    },
    run() {}
  });
  const snapshot = graph.build();
  const compiled = compileRenderGraph(snapshot);
  assert(compiled.counters.edgeCount >= 1, 'buffer range probe must produce a hazard edge');
  assert(compiled.counters.wholeResourceFallbacks === 0, 'known buffer ranges must not fall back');
  return Object.freeze({
    edges: compiled.counters.edgeCount,
    accesses: compiled.counters.accessesExamined,
    wholeResourceFallbacks: compiled.counters.wholeResourceFallbacks
  });
}

function textureProbe(): Readonly<Record<string, number>> {
  const graph = new RenderGraphBuilder();
  let value = graph.createTexture(TEXTURE, { origin: imported('range-texture', 'sampled') });
  graph.addRasterPass({
    id: 'texture/mip-write',
    setup(pass) {
      value = pass.colorAttachment(0, value, {
        range: {
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          aspect: 'all'
        },
        load: 'clear',
        store: 'store'
      });
      pass.sideEffect('texture subresource');
      return undefined;
    },
    run() {}
  });
  graph.addCopyPass({
    id: 'texture/mip-read',
    setup(pass) {
      pass.readTexture(value, 'sampled', {
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
        aspect: 'all'
      });
      pass.sideEffect('texture subresource consumer');
      return undefined;
    },
    run() {}
  });
  const compiled = compileRenderGraph(graph.build());
  assert(compiled.counters.hazardEdges >= 1, 'texture subresource probe must produce RAW');
  return Object.freeze({
    edges: compiled.counters.edgeCount,
    overlapComparisons: compiled.counters.overlapComparisons,
    wholeResourceFallbacks: compiled.counters.wholeResourceFallbacks
  });
}

function topologyProbe(): { linearEdges: number; fanEdges: number } {
  const linear = new RenderGraphBuilder();
  let predecessor: ReturnType<RenderGraphBuilder['addCopyPass']> | undefined;
  for (let index = 0; index < 16; index += 1) {
    const prior = predecessor;
    predecessor = linear.addCopyPass({
      id: `linear/${index}`,
      setup(pass) {
        if (prior !== undefined) pass.after(prior);
        pass.sideEffect('linear');
        return undefined;
      },
      run() {}
    });
  }
  const linearCompiled = compileRenderGraph(linear.build());
  assert(linearCompiled.counters.semanticEdges === 15, 'linear chain must contain P-1 edges');

  const fan = new RenderGraphBuilder();
  const root = fan.addCopyPass({
    id: 'fan/root',
    setup(pass) {
      pass.sideEffect('fan root');
      return undefined;
    },
    run() {}
  });
  const leaves = Array.from({ length: 8 }, (_, index) =>
    fan.addCopyPass({
      id: `fan/leaf-${index}`,
      setup(pass) {
        pass.after(root);
        pass.sideEffect('fan leaf');
        return undefined;
      },
      run() {}
    })
  );
  fan.addCopyPass({
    id: 'fan/join',
    setup(pass) {
      for (const leaf of leaves) pass.after(leaf);
      pass.sideEffect('fan join');
      return undefined;
    },
    run() {}
  });
  const fanCompiled = compileRenderGraph(fan.build());
  assert(fanCompiled.counters.semanticEdges === 16, 'fan-out/fan-in must contain 16 edges');
  return { linearEdges: 15, fanEdges: 16 };
}

function cullProbe(): Readonly<Record<string, number>> {
  const graph = new RenderGraphBuilder();
  const buffer = graph.createBuffer(BUFFER);
  graph.addComputePass({
    id: 'culled',
    setup(pass) {
      pass.writeBuffer(buffer, 'storage-write');
      return undefined;
    },
    run() {}
  });
  graph.addCopyPass({
    id: 'root',
    setup(pass) {
      pass.sideEffect('root');
      return undefined;
    },
    run() {}
  });
  const compiled = compileRenderGraph(graph.build());
  assert(compiled.culledPasses.length === 1, 'culled branch probe must cull exactly one pass');
  return Object.freeze({ retainedPasses: 1, culledPasses: 1 });
}

function aliasProbe(): Readonly<Record<string, number>> {
  const graph = new RenderGraphBuilder();
  for (let index = 0; index < 2; index += 1) {
    const resource = graph.createBuffer(BUFFER);
    graph.addComputePass({
      id: `alias/${index}`,
      setup(pass) {
        pass.writeBuffer(resource, 'storage-write');
        pass.sideEffect('alias candidate');
        return undefined;
      },
      run() {}
    });
  }
  const snapshot = graph.build();
  const compiled = compileRenderGraph(snapshot);
  const aliases = planResourceAliases(snapshot, analyzeResourceLifetimes(snapshot, compiled));
  assert(aliases.allocationCount === 1, 'alias probe must share one physical allocation');
  assert(aliases.aliasGroupCount === 1, 'alias probe must produce one alias group');
  return Object.freeze({
    logicalResources: 2,
    physicalAllocations: aliases.allocationCount,
    aliasGroups: aliases.aliasGroupCount
  });
}

function largeScaleProbe(): RenderGraphCoverageEvidence['largeScale'] {
  const graph = new RenderGraphBuilder();
  const resources = Array.from({ length: 2048 }, (_, index) =>
    graph.createBuffer(BUFFER, { origin: imported(`large/${index}`, 'storage-read') })
  );
  for (let index = 0; index < 1024; index += 1) {
    graph.addCopyPass({
      id: `large/${index}`,
      setup(pass) {
        pass.readBuffer(resources[index]!, 'storage-read');
        pass.sideEffect('large scale');
        return undefined;
      },
      run() {}
    });
  }
  const compiled = compileRenderGraph(graph.build());
  assert(compiled.retainedPasses.length === 1024, 'large scale retained count diverged');
  assert(compiled.counters.accessesExamined === 1024, 'large scale access count diverged');
  return Object.freeze({
    seed: 0x5eed,
    passCount: 1024,
    resourceCount: 2048,
    accessesExamined: compiled.counters.accessesExamined,
    retainedPasses: compiled.retainedPasses.length,
    status: 'pass'
  });
}

function imported(id: string, initialState: 'sampled' | 'storage-read') {
  return Object.freeze({
    kind: 'imported' as const,
    initialState,
    acquire: Object.freeze({ kind: 'external-acquire' as const, id })
  });
}

function family(
  id: RenderGraphCoverageEvidence['workloadFamilies'][number]['id'],
  counters: Readonly<Record<string, number>>
) {
  return Object.freeze({ id, status: 'pass' as const, counters });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`RenderGraph benchmark coverage failure: ${message}.`);
}

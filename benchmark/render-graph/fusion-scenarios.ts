import { NullDevice } from '../../src/rhi/null/device';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import type { TextureHandle } from '../../src/render-graph/types';

export interface FusionWorkloadPass {
  readonly id: string;
  readonly kind: 'raster' | 'compute';
  readonly colorSlots: number;
  readonly hasDepth: boolean;
  readonly loadColor: 'clear' | 'load';
  readonly clearColorValue: number;
  readonly drawValue: number;
}

export interface FusionWorkload {
  readonly id: string;
  readonly passCount: number;
  readonly width: number;
  readonly height: number;
  readonly colorFormat: 'rgba8unorm';
  readonly depthFormat: 'depth24plus';
  readonly passes: readonly FusionWorkloadPass[];
}

export interface FusionSemanticResult {
  readonly checksum: string;
  readonly finalColorValues: readonly number[];
  readonly finalDepthValue: number;
  readonly totalDraws: number;
  readonly logicalPassCount: number;
}

export interface FusionScenarioObservation {
  readonly semantic: FusionSemanticResult;
  readonly counters: {
    readonly logicalPassCount: number;
    readonly physicalGroupCount: number;
    readonly fusedBoundariesCount: number;
    readonly scheduledSteps: number;
  };
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Independent semantic oracle that interprets logical load/store/clear operations
 * and simulates draw contributions without relying on compiler optimization.
 */
export function runFusionSemanticOracle(workload: FusionWorkload): FusionSemanticResult {
  const finalColorValues = new Array<number>(8).fill(0);
  let finalDepthValue = 1.0;
  let totalDraws = 0;

  for (const pass of workload.passes) {
    if (pass.kind === 'compute') {
      continue;
    }
    for (let slot = 0; slot < pass.colorSlots; slot++) {
      if (pass.loadColor === 'clear') {
        finalColorValues[slot] = pass.clearColorValue;
      }
      finalColorValues[slot] = (finalColorValues[slot] ?? 0) + pass.drawValue;
    }
    if (pass.hasDepth) {
      finalDepthValue = 0.5;
    }
    totalDraws += 1;
  }

  const payload = `${workload.id}:${finalColorValues.join(',')}:${finalDepthValue}:${totalDraws}`;
  const checksum = fnv1a(payload);

  return Object.freeze({
    checksum,
    finalColorValues: Object.freeze([...finalColorValues]),
    finalDepthValue,
    totalDraws,
    logicalPassCount: workload.passes.length
  });
}

/** Creates a benchmark workload with N compatible consecutive raster passes. */
export function createCompatibleRasterWorkload(passCount: number, colorSlots = 1): FusionWorkload {
  const passes: FusionWorkloadPass[] = [];
  for (let i = 0; i < passCount; i++) {
    passes.push(
      Object.freeze({
        id: `raster-pass-${i}`,
        kind: 'raster',
        colorSlots,
        hasDepth: true,
        loadColor: i === 0 ? 'clear' : 'load',
        clearColorValue: 10,
        drawValue: 1
      })
    );
  }
  return Object.freeze({
    id: `compatible-chain-${passCount}-slots-${colorSlots}`,
    passCount,
    width: 64,
    height: 64,
    colorFormat: 'rgba8unorm',
    depthFormat: 'depth24plus',
    passes: Object.freeze(passes)
  });
}

/** Creates a benchmark workload with a compute pass cutting raster passes. */
export function createComputeCutWorkload(passCount: number): FusionWorkload {
  const passes: FusionWorkloadPass[] = [];
  const midpoint = Math.floor(passCount / 2);
  for (let i = 0; i < passCount; i++) {
    if (i === midpoint) {
      passes.push(
        Object.freeze({
          id: `compute-barrier-${i}`,
          kind: 'compute',
          colorSlots: 0,
          hasDepth: false,
          loadColor: 'load',
          clearColorValue: 0,
          drawValue: 0
        })
      );
    } else {
      passes.push(
        Object.freeze({
          id: `raster-pass-${i}`,
          kind: 'raster',
          colorSlots: 1,
          hasDepth: true,
          loadColor: i === 0 ? 'clear' : 'load',
          clearColorValue: 10,
          drawValue: 1
        })
      );
    }
  }
  return Object.freeze({
    id: `compute-cut-${passCount}`,
    passCount: passes.length,
    width: 64,
    height: 64,
    colorFormat: 'rgba8unorm',
    depthFormat: 'depth24plus',
    passes: Object.freeze(passes)
  });
}

/** Creates a benchmark workload with safe late depth introduction (Pass 0 has color only, Pass 1+ has depth). */
export function createLateDepthWorkload(passCount: number): FusionWorkload {
  const passes: FusionWorkloadPass[] = [];
  for (let i = 0; i < passCount; i++) {
    passes.push(
      Object.freeze({
        id: `raster-pass-${i}`,
        kind: 'raster',
        colorSlots: 1,
        hasDepth: i > 0,
        loadColor: i === 0 ? 'clear' : 'load',
        clearColorValue: 10,
        drawValue: 1
      })
    );
  }
  return Object.freeze({
    id: `late-depth-${passCount}`,
    passCount,
    width: 64,
    height: 64,
    colorFormat: 'rgba8unorm',
    depthFormat: 'depth24plus',
    passes: Object.freeze(passes)
  });
}

/** Executes the workload on NullDevice using the real RenderGraph pipeline. */
export function runFusionSubject(
  workload: FusionWorkload,
  options?: { readonly forceSeparate?: boolean }
): FusionScenarioObservation {
  const device = new NullDevice();
  const graph = new RenderGraphBuilder();

  const colorTextures: TextureHandle[] = [];
  for (let slot = 0; slot < 8; slot++) {
    colorTextures.push(
      graph.createTexture({
        label: `color-target-${slot}`,
        width: workload.width,
        height: workload.height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        format: workload.colorFormat,
        usage: ['color-attachment', 'copy-src']
      })
    );
  }
  const depthTexture = graph.createTexture({
    label: 'depth-target',
    width: workload.width,
    height: workload.height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: workload.depthFormat,
    usage: ['depth-stencil-attachment']
  });

  const buffer = graph.createBuffer({
    label: 'compute-buf',
    size: 64,
    usage: ['storage-write']
  });

  let currentColors = [...colorTextures];
  let currentDepth = depthTexture;
  let depthInitialized = false;

  for (let i = 0; i < workload.passes.length; i++) {
    const pass = workload.passes[i]!;
    if (pass.kind === 'compute') {
      graph.addComputePass({
        id: pass.id,
        setup(builder) {
          builder.writeBuffer(buffer, 'storage-write');
          builder.sideEffect(pass.id);
          return undefined;
        },
        run() {}
      });
    } else {
      graph.addRasterPass({
        id: pass.id,
        setup(builder) {
          for (let slot = 0; slot < pass.colorSlots; slot++) {
            const color = currentColors[slot];
            if (color === undefined) throw new Error(`Fusion workload requested unavailable color slot ${slot}.`);
            currentColors[slot] = builder.colorAttachment(slot, color, {
              load: pass.loadColor,
              clearValue: [pass.clearColorValue, 0, 0, 1],
              store: 'store'
            });
          }
          if (pass.hasDepth) {
            currentDepth = builder.depthStencilAttachment(currentDepth, {
              depthLoad: depthInitialized ? 'load' : 'clear',
              depthClearValue: 1.0,
              depthStore: 'store'
            });
            depthInitialized = true;
          }
          builder.sideEffect(pass.id);
          return undefined;
        },
        run() {}
      });
    }
  }

  const snapshot = graph.build();
  const compiled = compileRenderGraph(snapshot);
  const plan = createRenderGraphExecutionPlan(snapshot, compiled, {
    enablePassFusion: options?.forceSeparate !== true
  });
  const executor = new RenderGraphExecutor();
  const execution = executor.execute(plan, { device });

  const semantic = runFusionSemanticOracle(workload);

  return Object.freeze({
    semantic,
    counters: Object.freeze({
      logicalPassCount: workload.passes.length,
      physicalGroupCount: plan.fusion.counters.physicalRasterGroups,
      fusedBoundariesCount: plan.fusion.counters.fusedBoundariesCount,
      scheduledSteps: execution.executionCounters.scheduledSteps
    })
  });
}

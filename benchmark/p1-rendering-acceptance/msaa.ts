import assert from 'node:assert/strict';
import { NullDevice } from '../../src/rhi/null/device';
import { RenderGraphBuilder, RenderGraphExecutor } from '../../src/render-graph';
import { createOpaqueRenderSystem } from '../../src/rendering/phase/opaque-render-system';
import { resolveBaselineSampleCount } from '../../src/rendering/baseline/baseline-options';
import { RenderSystemRegistry, compileRenderSystems } from '../../src/rendering/systems';
import type { RenderEntityId } from '../../src/rendering/world';
import type { RenderView } from '../../src/rendering/visibility/types';
import type { AcceptanceObservation } from './types';

/**
 * Executes empty-draw opaque passes; measures graph CPU work, not GPU raster cost.
 * @throws When the positive view count or production attachment/resolve invariants are invalid.
 */
export async function observeMsaa(
  viewCount: number,
  sampleCount: 1 | 4
): Promise<AcceptanceObservation> {
  assert.ok(Number.isSafeInteger(viewCount) && viewCount > 0);
  const device = createMultisampleNullDevice();
  assert.deepEqual(resolveBaselineSampleCount(device, sampleCount), { sampleCount });
  const graph = new RenderGraphBuilder();
  const registry = new RenderSystemRegistry();
  const views: RenderView[] = [];
  for (let index = 0; index < viewCount; index += 1) {
    const id = `acceptance-${index}`;
    views.push({
      id,
      camera: index as RenderEntityId,
      surface: id,
      viewport: { x: 0, y: 0, width: 64, height: 64 },
      layerMask: 1,
      featurePolicyKey: 'acceptance-v1',
      historyKey: id
    });
    const color = graph.createTexture(texture('rgba16float', sampleCount));
    const depth = graph.createTexture(texture('depth24plus', sampleCount));
    const resolved = sampleCount === 4 ? graph.createTexture(texture('rgba16float', 1)) : undefined;
    const opaque = createOpaqueRenderSystem({
      id,
      phase: { viewId: id, phase: 'opaque', packets: [] },
      surfaceFrame: { kind: 'surface-frame', id },
      color: texture('rgba16float', sampleCount),
      depth: texture('depth24plus', sampleCount),
      colorTarget: color,
      depthTarget: depth,
      ...(resolved === undefined ? {} : { resolveTarget: resolved }),
      present: false
    });
    const descriptor = opaque.descriptor;
    assert.equal(descriptor.kind, 'raster');
    if (descriptor.kind !== 'raster') throw new Error('Opaque descriptor must be raster.');
    registry.add({
      ...descriptor,
      setup(...[pass, context]: Parameters<typeof descriptor.setup>) {
        const resources = descriptor.setup(pass, context);
        // Empty draws still exercise attachment allocation/resolve; retain the pass explicitly.
        pass.sideEffect(`acceptance-${index}`);
        return resources;
      }
    });
  }
  const compiled = compileRenderSystems(registry, { views, graph });
  const passes = compiled.plan.snapshot.passes;
  const resources = compiled.plan.snapshot.resources;
  assert.equal(passes.length, viewCount);
  let resolves = 0;
  for (const pass of passes) {
    assert.ok(pass.rasterDetails);
    resolves += pass.rasterDetails.resolveAttachments.length;
    for (const resolve of pass.rasterDetails.resolveAttachments) {
      const source = resources.find(
        (resource) => resource.resourceId === resolve.source.resourceId
      );
      const destination = resources.find(
        (resource) => resource.resourceId === resolve.destination.resourceId
      );
      assert.ok(source?.kind === 'texture' && destination?.kind === 'texture');
      assert.equal(source.descriptor.sampleCount, 4);
      assert.equal(destination.descriptor.sampleCount, 1);
      assert.equal(source.descriptor.format, destination.descriptor.format);
      assert.notEqual(source.resourceId, destination.resourceId);
    }
  }
  assert.equal(resolves, sampleCount === 4 ? viewCount : 0);
  const counts = resources
    .filter((resource) => resource.kind === 'texture')
    .map((resource) => {
      assert.equal(resource.descriptor.width, 64);
      return resource.descriptor.sampleCount;
    });
  assert.equal(counts.filter((count) => count === sampleCount).length, viewCount * 2);
  assert.equal(resources.length, viewCount * (sampleCount === 4 ? 3 : 2));
  const execution = new RenderGraphExecutor().execute(compiled.plan, { device });
  assert.equal(execution.commandStats.renderPasses, viewCount);
  assert.equal(device.queue.metrics().submitted, 1);
  await execution.submission.done;
  execution.commandBuffer.dispose();
  device.destroy();
  const counters = {
    views: viewCount,
    sampleCount,
    resolves,
    textures: resources.length,
    renderPasses: execution.commandStats.renderPasses,
    submissions: 1
  };
  return { checksum: JSON.stringify(counters), counters };
}

function createMultisampleNullDevice(): NullDevice {
  const source = new NullDevice();
  const capabilities = source.capabilities;
  const formats = new Map(capabilities.formats);
  for (const format of ['rgba16float', 'depth24plus'] as const) {
    formats.set(format, {
      sample: true,
      filter: false,
      render: true,
      blend: false,
      storage: false,
      copySrc: true,
      copyDst: true,
      sampleCounts: [1, 4]
    });
  }
  source.destroy();
  // This is declared Null capability coverage; it does not assert real-device 4x support.
  return new NullDevice({ capabilities: { ...capabilities, formats } });
}

function texture(format: 'rgba16float' | 'depth24plus', sampleCount: 1 | 4) {
  return {
    width: 64,
    height: 64,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount,
    format,
    usage: [format === 'rgba16float' ? 'color-attachment' : 'depth-stencil-attachment']
  } as const;
}

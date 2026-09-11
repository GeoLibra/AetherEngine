import {
  RenderGraphBuilder,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  type ColorAttachmentOptions,
  type RasterPassContext,
  type TextureHandle
} from '../../render-graph';
import type { CompositionLoadOp, CompositionPlan, CompositionSlot } from './types';
import { ReadonlyMapSnapshot } from '../world/readonly-collection-snapshot';

export interface CompositionSlotResources {
  readonly color: TextureHandle;
  readonly slot: CompositionSlot;
}

export interface CompositionSlotRecorder {
  record(context: RasterPassContext, resources: CompositionSlotResources): void;
}

export interface LoweredCompositionPlan {
  readonly plan: ReturnType<typeof createRenderGraphExecutionPlan>;
  readonly surfaceFrameTokens: ReadonlyMap<string, string>;
}

/** Lowers one canonical composition plan into the sole RenderGraph scheduling authority. */
export function lowerCompositionPlan(
  composition: CompositionPlan,
  recorders: ReadonlyMap<string, CompositionSlotRecorder>
): LoweredCompositionPlan {
  const graph = new RenderGraphBuilder();
  const currentColor = new Map<string, TextureHandle>();
  const surfaceFrameTokens = new Map<string, string>();
  for (const surface of composition.surfaces) {
    if (!composition.presentOwners.has(surface.id)) continue;
    surfaceFrameTokens.set(surface.id, surface.id);
  }
  for (const slot of composition.slots) {
    const surface = composition.surfaces.find(({ id }) => id === slot.targetId);
    if (surface === undefined || !composition.presentOwners.has(surface.id)) continue;
    const recorder = recorders.get(slot.id);
    if (recorder === undefined) throw new Error(`Composition slot "${slot.id}" has no recorder.`);
    graph.addRasterPass<CompositionSlotResources>({
      id: `composition:${composition.id}:${slot.id}`,
      setup(pass) {
        const source =
          currentColor.get(surface.id) ??
          pass.createTexture(
            {
              label: `composition:${surface.id}`,
              width: surface.width,
              height: surface.height,
              depthOrArrayLayers: 1,
              mipLevelCount: 1,
              sampleCount: 1,
              format: surface.format,
              usage: ['color-attachment']
            },
            {
              origin: {
                kind: 'imported',
                initialState: 'undefined',
                acquire: { kind: 'external-acquire', id: surface.id }
              }
            }
          );
        const color = pass.colorAttachment(0, source, colorAttachmentOptions(slot));
        currentColor.set(surface.id, color);
        if (composition.presentOwners.get(surface.id) === slot.id) {
          pass.present(color, { kind: 'surface-frame', id: surface.id });
        }
        return { color, slot };
      },
      run(context, resources) {
        recorder.record(context, resources);
      }
    });
  }
  const snapshot = graph.build();
  return Object.freeze({
    plan: createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
    surfaceFrameTokens: new ReadonlyMapSnapshot(surfaceFrameTokens)
  });
}

function colorAttachmentOptions(slot: CompositionSlot): ColorAttachmentOptions {
  return Object.freeze({
    load: mapColorLoad(slot.colorLoad),
    store: slot.stores.color ? 'store' : 'discard',
    clearValue: { r: 0, g: 0, b: 0, a: 0 }
  });
}

function mapColorLoad(load: CompositionLoadOp): ColorAttachmentOptions['load'] {
  if (load === 'discard') {
    throw new Error('Composition slots with colorLoad "discard" cannot declare a raster pass.');
  }
  return load;
}

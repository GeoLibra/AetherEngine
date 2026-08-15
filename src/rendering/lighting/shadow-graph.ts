import {
  RenderGraphBuilder,
  type PassToken,
  type RestrictedPassContext,
  type TextureHandle,
  type TextureRange
} from '../../render-graph';
import { shadowRequestKey } from './shadow';
import type { ShadowRequest } from './types';
import { ReadonlyMapSnapshot } from '../readonly-collection-snapshot';

export interface ShadowGraphDeclaration {
  readonly texture: TextureHandle | undefined;
  readonly passes: readonly PassToken[];
  readonly layerByRequestKey: ReadonlyMap<string, number>;
}

export interface ShadowDepthPassRecord {
  readonly request: ShadowRequest;
  readonly layer: number;
  readonly texture: TextureHandle;
  readonly range: TextureRange;
}

export type ShadowDepthPassRecorder = (
  context: RestrictedPassContext,
  pass: ShadowDepthPassRecord
) => void;

const NO_SHADOW_PASSES: readonly PassToken[] = Object.freeze([]);

/**
 * Declares accepted shadow requests as independent depth array-layer writes. The physical backend
 * may later map those layers to atlas tiles; the graph remains the sole ordering authority.
 */
export function declareShadowDepthPasses(
  graph: RenderGraphBuilder,
  requests: readonly ShadowRequest[],
  options: {
    readonly record: ShadowDepthPassRecorder;
    readonly format?: string;
    readonly label?: string;
  }
): ShadowGraphDeclaration {
  const acceptedRequests = requests.map(snapshotShadowRequest);
  const record = options.record;
  const format = options.format ?? 'depth32float';
  const label = options.label ?? 'lighting-shadow-depth';
  if (acceptedRequests.length === 0) {
    return Object.freeze({
      texture: undefined,
      passes: NO_SHADOW_PASSES,
      layerByRequestKey: new ReadonlyMapSnapshot<string, number>([])
    });
  }
  const edge = Math.max(...acceptedRequests.map((request) => request.resolutionClass));
  let texture = graph.createTexture({
    label,
    width: edge,
    height: edge,
    depthOrArrayLayers: acceptedRequests.length,
    mipLevelCount: 1,
    sampleCount: 1,
    format,
    usage: ['depth-stencil-attachment', 'sampled']
  });
  const passes: PassToken[] = [];
  const layerByRequestKey = new Map<string, number>();
  for (let layer = 0; layer < acceptedRequests.length; layer++) {
    const request = acceptedRequests[layer]!;
    const key = shadowRequestKey(request);
    if (layerByRequestKey.has(key)) throw new Error(`Duplicate shadow request key "${key}".`);
    layerByRequestKey.set(key, layer);
    const source = texture;
    let next = source;
    const range: TextureRange = Object.freeze({
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: layer,
      arrayLayerCount: 1,
      aspect: 'depth-only'
    });
    const token = graph.addPass<
      Readonly<{ texture: TextureHandle; range: TextureRange }>,
      RestrictedPassContext
    >({
      id: `shadow:${key}`,
      setup(pass) {
        next = pass.writeTexture(source, 'depth-stencil-attachment', range);
        return { texture: next, range };
      },
      run(context, resources) {
        record(
          context,
          Object.freeze({ request, layer, texture: resources.texture, range: resources.range })
        );
      }
    });
    texture = next;
    passes.push(token);
  }
  return Object.freeze({
    texture,
    passes: Object.freeze(passes),
    layerByRequestKey: new ReadonlyMapSnapshot(layerByRequestKey)
  });
}

function snapshotShadowRequest(request: ShadowRequest): ShadowRequest {
  // The graph can execute much later than declaration, so request identity cannot remain owned by
  // the caller. Keep exactly the validated public request facts used by keying and pass execution.
  return Object.freeze({
    lightEntity: request.lightEntity,
    viewId: request.viewId,
    kind: request.kind,
    subresourceIndex: request.subresourceIndex,
    resolutionClass: request.resolutionClass,
    importance: request.importance,
    casterRevision: request.casterRevision
  });
}

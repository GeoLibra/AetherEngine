import {
  RenderGraphBuilder,
  type PassToken,
  type RestrictedPassContext,
  type TextureHandle,
  type TextureRange
} from '../../render-graph';
import { shadowRequestKey } from './shadow';
import type { ShadowRequest } from './types';

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
  if (requests.length === 0) {
    return Object.freeze({
      texture: undefined,
      passes: Object.freeze([]),
      layerByRequestKey: new Map()
    });
  }
  const edge = Math.max(...requests.map((request) => request.resolutionClass));
  let texture = graph.createTexture({
    label: options.label ?? 'lighting-shadow-depth',
    width: edge,
    height: edge,
    depthOrArrayLayers: requests.length,
    mipLevelCount: 1,
    sampleCount: 1,
    format: options.format ?? 'depth32float',
    usage: ['depth-stencil-attachment', 'sampled']
  });
  const passes: PassToken[] = [];
  const layerByRequestKey = new Map<string, number>();
  for (let layer = 0; layer < requests.length; layer++) {
    const request = requests[layer]!;
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
        options.record(
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
    layerByRequestKey
  });
}

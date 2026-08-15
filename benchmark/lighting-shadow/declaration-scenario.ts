import { RenderGraphBuilder } from '../../src/render-graph';
import { declareShadowDepthPasses, type ShadowRequest } from '../../src/rendering';

export interface ShadowDeclarationWorkload {
  readonly requests: readonly ShadowRequest[];
  readonly expectedLayers: readonly (readonly [key: string, layer: number])[];
}

export function createShadowDeclarationWorkload(count: number): ShadowDeclarationWorkload {
  const requests = Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        lightEntity: (index + 1) as ShadowRequest['lightEntity'],
        viewId: `benchmark-view-${index % 4}`,
        kind: 'spot' as const,
        subresourceIndex: index,
        resolutionClass: 32,
        importance: count - index,
        casterRevision: 1
      })
    )
  );
  return Object.freeze({
    requests,
    // Keep this calculation independent from shadowRequestKey: declaration order is the layer.
    expectedLayers: Object.freeze(
      requests.map((request, layer) =>
        Object.freeze([
          JSON.stringify([
            request.lightEntity,
            request.viewId,
            request.kind,
            request.subresourceIndex
          ]),
          layer
        ] as const)
      )
    )
  });
}

export function assertDeclaredShadowLayers(
  workload: ShadowDeclarationWorkload,
  publishedLayers?: ReadonlyMap<string, number>
): readonly (readonly [key: string, layer: number])[] {
  const layers =
    publishedLayers ??
    declareShadowDepthPasses(new RenderGraphBuilder(), workload.requests, {
      record: () => undefined
    }).layerByRequestKey;
  const actual: Array<readonly [string, number]> = [];
  for (const [key, expectedLayer] of workload.expectedLayers) {
    const actualLayer = layers.get(key);
    if (actualLayer !== expectedLayer) {
      throw new Error(
        `Shadow declaration layer mismatch for ${key}: expected ${expectedLayer}, got ${actualLayer}.`
      );
    }
    actual.push(Object.freeze([key, actualLayer] as const));
  }
  if (layers.size !== workload.expectedLayers.length) {
    throw new Error('Shadow declaration key count differs from the deterministic request oracle.');
  }
  return Object.freeze(actual);
}

import {
  createMaterialAsset,
  createMaterialTechniqueRole,
  defineMaterialSchema,
  resolveMaterialPipelineCompatibility,
  type MaterialAsset,
  type MaterialPipelineContext,
  type PreparedAssetLease,
  type PreparedMaterialCompatibility,
  type PreparedMesh,
  type PreparedMeshQueueCandidate,
  type PreparedVariantKey,
  type RenderEntityId
} from '../../src';
import { observation } from './reference';
import type { MaterialScenarioCase, MaterialScenarioObservation } from './types';

export interface MaterialPipelineCompatibilityOptions {
  readonly instanceCount: number;
  readonly uniqueMeshLayouts: number;
  readonly seed: number;
}

export function createMaterialPipelineCompatibilityCase(
  options: MaterialPipelineCompatibilityOptions
): MaterialScenarioCase {
  validateOptions(options);
  const fixture = createFixture(options);
  const expected = referenceObservation(options);
  return Object.freeze({
    scenarioId: 'pipeline-compatibility-resolution-v1',
    scenarioVersion: 1,
    caseId: `instances-${options.instanceCount}-mesh-layouts-${options.uniqueMeshLayouts}`,
    scale: Object.freeze({
      instanceCount: options.instanceCount,
      uniqueMeshLayouts: options.uniqueMeshLayouts,
      fallbackEvery: 20,
      unsupportedEvery: 20
    }),
    expected: Object.freeze({ reference: expected.counters, subject: expected.counters }),
    runReference: () => referenceObservation(options),
    runSubject: () => runSubject(fixture)
  });
}

function createFixture(options: MaterialPipelineCompatibilityOptions): Readonly<{
  candidates: readonly PreparedMeshQueueCandidate[];
  context: MaterialPipelineContext;
}> {
  const exactRole = createMaterialTechniqueRole('gbuffer');
  const fallbackRole = createMaterialTechniqueRole('forward');
  const schema = defineMaterialSchema({ id: 'benchmark-compatibility', version: 1, fields: {} });
  const compatibility = Object.freeze({
    semanticTag: 'lit',
    bindingLayoutHash: 'layout',
    requiredFeatures: Object.freeze([]),
    requiredMaterialFeatures: Object.freeze([]),
    requiredViewFeatures: Object.freeze([]),
    requiredMeshCapabilities: Object.freeze([]),
    attachmentFormats: Object.freeze(['rgba16float']),
    depthStencilFormats: Object.freeze(['depth24plus']),
    sampleCounts: Object.freeze([1])
  });
  const exactAsset = createMaterialAsset({
    id: 'benchmark-compatibility-exact',
    version: 1,
    schema,
    techniques: [
      {
        name: 'exact',
        passRole: exactRole,
        shader: { moduleKey: 'shader-exact', vertexEntry: 'vs', fragmentEntry: 'fs' },
        priority: 1,
        compatibility
      }
    ],
    renderState: { surface: 'opaque', cullMode: 'back' }
  });
  const fallbackAsset = createMaterialAsset({
    id: 'benchmark-compatibility-fallback',
    version: 1,
    schema,
    techniques: [
      {
        name: 'fallback',
        passRole: fallbackRole,
        fallbackFor: [exactRole],
        shader: { moduleKey: 'shader-fallback', vertexEntry: 'vs', fragmentEntry: 'fs' },
        priority: 1,
        compatibility
      }
    ],
    renderState: { surface: 'opaque', cullMode: 'back' }
  });
  const unsupportedAsset = createMaterialAsset({
    id: 'benchmark-compatibility-unsupported',
    version: 1,
    schema,
    techniques: [],
    renderState: { surface: 'opaque' }
  });
  const materials = Object.freeze({
    selected: preparedMaterialLease(exactAsset),
    fallback: preparedMaterialLease(fallbackAsset),
    skipped: preparedMaterialLease(unsupportedAsset)
  });
  const meshes = Array.from({ length: options.uniqueMeshLayouts }, (_, index) =>
    preparedMeshLease(index)
  );
  const candidates = Array.from({ length: options.instanceCount }, (_, index) => {
    const kind = category(index);
    const mesh = meshes[layoutIndex(index, kind, options.uniqueMeshLayouts)];
    if (mesh === undefined) throw new Error('Material compatibility mesh fixture is incomplete.');
    return Object.freeze({
      entity: index as RenderEntityId,
      depthRange: Object.freeze([-2, -1]) as readonly [number, number],
      submesh: 0,
      mesh,
      material: materials[kind]
    });
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    context: Object.freeze({
      phase: 'opaque',
      allowedRoles: Object.freeze([exactRole, fallbackRole]),
      availableFeatures: Object.freeze([]),
      availableMeshCapabilities: Object.freeze([]),
      availableViewFeatures: Object.freeze([]),
      attachmentFormats: Object.freeze(['rgba16float']),
      depthStencilFormat: 'depth24plus',
      sampleCount: 1,
      semanticTag: 'lit',
      featurePolicyHash: `benchmark-policy-${options.seed}`,
      deviceGeneration: 1
    })
  });
}

function runSubject(fixture: ReturnType<typeof createFixture>): MaterialScenarioObservation {
  const result = resolveMaterialPipelineCompatibility(fixture.candidates, fixture.context);
  const selected = result.resolved.filter((entry) => entry.selection.status === 'selected').length;
  return resultObservation({
    candidates: fixture.candidates.length,
    selected,
    fallback: result.resolved.length - selected,
    skipped: result.skipped.length,
    uniquePipelineKeys: new Set(result.resolved.map((entry) => entry.pipelineKey.canonicalValue))
      .size
  });
}

function referenceObservation(
  options: MaterialPipelineCompatibilityOptions
): MaterialScenarioObservation {
  let selected = 0;
  let fallback = 0;
  let skipped = 0;
  const keys = new Set<string>();
  for (let index = 0; index < options.instanceCount; index += 1) {
    const kind = category(index);
    if (kind === 'skipped') {
      skipped += 1;
      continue;
    }
    if (kind === 'fallback') fallback += 1;
    else selected += 1;
    keys.add(`${kind}:${layoutIndex(index, kind, options.uniqueMeshLayouts)}`);
  }
  return resultObservation({
    candidates: options.instanceCount,
    selected,
    fallback,
    skipped,
    uniquePipelineKeys: keys.size
  });
}

function resultObservation(
  counts: Readonly<{
    candidates: number;
    selected: number;
    fallback: number;
    skipped: number;
    uniquePipelineKeys: number;
  }>
): MaterialScenarioObservation {
  const counters = Object.freeze({ ...counts, synchronousCompiles: 0, staleReuse: 0 });
  return observation(Object.freeze({ compatibility: counters }), counters);
}

function category(index: number): 'selected' | 'fallback' | 'skipped' {
  if (index % 20 === 0) return 'skipped';
  if (index % 20 === 1) return 'fallback';
  return 'selected';
}

function layoutIndex(
  index: number,
  kind: ReturnType<typeof category>,
  uniqueMeshLayouts: number
): number {
  return kind === 'selected'
    ? index % uniqueMeshLayouts
    : Math.floor(index / 20) % uniqueMeshLayouts;
}

function preparedMaterialLease(
  asset: MaterialAsset
): PreparedAssetLease<PreparedMaterialCompatibility> {
  return lease(
    variantKey(asset.id, 'material-v1'),
    Object.freeze({
      deviceGeneration: 1,
      asset,
      bindingLayoutHash: 'layout',
      selectedVariant: 'base',
      availableMaterialFeatures: Object.freeze([])
    })
  );
}

function preparedMeshLease(layout: number): PreparedAssetLease<PreparedMesh> {
  return lease(
    variantKey(`mesh-${layout}`, 'mesh-v1'),
    Object.freeze({
      deviceGeneration: 1,
      layout: Object.freeze({
        topology: 'triangles' as const,
        frontFace: 'ccw' as const,
        streams: Object.freeze([
          Object.freeze({
            semantic: `POSITION_${layout}`,
            format: 'float32x3' as const,
            stride: 12,
            offset: 0,
            bufferSlot: 0
          })
        ])
      }),
      vertexBuffers: Object.freeze([]),
      submeshes: Object.freeze([{ start: 0, count: 3, materialSlot: 0 }]),
      byteLength: 0
    })
  );
}

function lease<T>(key: PreparedVariantKey, value: T): PreparedAssetLease<T> {
  return Object.freeze({
    prepared: Object.freeze({ key: Object.freeze(key), value }),
    disposed: false,
    retainUntil() {},
    dispose() {}
  });
}

function variantKey(assetId: string, abiVersion: string): PreparedVariantKey {
  return Object.freeze({
    assetId,
    payloadVersion: 1,
    deviceGeneration: 1,
    featurePolicyKey: 'benchmark-policy',
    abiVersion
  });
}

function validateOptions(options: MaterialPipelineCompatibilityOptions): void {
  if (!Number.isSafeInteger(options.instanceCount) || options.instanceCount < 1)
    throw new Error('Material compatibility benchmark instance count must be positive.');
  if (!Number.isSafeInteger(options.uniqueMeshLayouts) || options.uniqueMeshLayouts < 1)
    throw new Error('Material compatibility benchmark unique mesh layouts must be positive.');
}

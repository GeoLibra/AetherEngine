import { compareCodeUnits, fnv1a32Hex } from '../../core';
import { resolveMaterialRenderState, selectMaterialTechnique } from '../../material';
import { createPipelineKey } from '../pipeline/pipeline-resolver';
import type {
  MaterialPipelineCompatibilitySkip,
  MaterialPipelineCompatibilityResult,
  MaterialPipelineContext,
  PreparedMaterialCompatibility,
  ResolvedMaterialPipelineCandidate
} from './types';
import type { PreparedMeshQueueCandidate } from '../mesh/types';

/** Resolves prepared candidates without compiling pipelines or taking ownership of their leases. */
export function resolveMaterialPipelineCompatibility(
  candidates: readonly PreparedMeshQueueCandidate[],
  context: MaterialPipelineContext
): MaterialPipelineCompatibilityResult {
  validateContext(context);
  const resolved: ResolvedMaterialPipelineCandidate[] = [];
  const skipped: MaterialPipelineCompatibilitySkip[] = [];
  for (const candidate of candidates) {
    const material = candidate.material.prepared.value;
    const invalid = validatePreparedMaterial(material);
    if (invalid !== undefined) {
      skipped.push(skip(candidate, 'invalid-material-payload', invalid));
      continue;
    }
    if (
      candidate.mesh.prepared.value.deviceGeneration !== context.deviceGeneration ||
      material.deviceGeneration !== context.deviceGeneration
    ) {
      skipped.push(
        skip(
          candidate,
          'device-generation-stale',
          `Prepared candidate generation does not match device generation ${context.deviceGeneration}.`,
          material.asset.id
        )
      );
      continue;
    }
    const request = {
      phase: context.phase,
      allowedRoles: context.allowedRoles,
      availableFeatures: context.availableFeatures,
      availableMaterialFeatures: material.availableMaterialFeatures,
      availableMeshCapabilities: context.availableMeshCapabilities,
      availableViewFeatures: context.availableViewFeatures,
      bindingLayoutHash: material.bindingLayoutHash,
      attachmentFormats: context.attachmentFormats,
      ...(context.depthStencilFormat === undefined
        ? {}
        : { depthStencilFormat: context.depthStencilFormat }),
      sampleCount: context.sampleCount,
      semanticTag: context.semanticTag
    };
    const selection = selectMaterialTechnique(material.asset, request);
    if (selection.status === 'unsupported') {
      const layoutCompatible = material.asset.techniques.some(
        (technique) => technique.compatibility.bindingLayoutHash === material.bindingLayoutHash
      );
      const code = layoutCompatible ? 'variant-unsupported' : 'layout-incompatible';
      skipped.push(skip(candidate, code, selection.diagnostic.message, material.asset.id));
      continue;
    }
    const renderState = resolveMaterialRenderState(
      material.asset.renderState,
      { phase: context.phase, allowedOverrideRoles: context.allowedRoles },
      selection.technique
    );
    if (renderState.status === 'conflict') {
      skipped.push(
        skip(
          candidate,
          'render-state-conflict',
          renderState.diagnostic.message,
          material.asset.id,
          selection.technique.name
        )
      );
      continue;
    }
    const pipelineKey = buildPipelineKeyForCandidate(
      candidate,
      material,
      selection,
      renderState,
      context
    );
    resolved.push(Object.freeze({ candidate, selection, renderState, pipelineKey }));
  }
  return Object.freeze({ resolved: Object.freeze(resolved), skipped: Object.freeze(skipped) });
}

function validatePreparedMaterial(material: PreparedMaterialCompatibility): string | undefined {
  if (material === null || typeof material !== 'object')
    return 'Prepared material must be an object.';
  if (!Number.isSafeInteger(material.deviceGeneration) || material.deviceGeneration < 0)
    return 'Prepared material device generation must be a non-negative safe integer.';
  if (!material.bindingLayoutHash?.trim())
    return 'Prepared material binding layout must be non-empty.';
  if (!material.selectedVariant?.trim()) return 'Prepared material variant must be non-empty.';
  if (!Array.isArray(material.availableMaterialFeatures))
    return 'Prepared material feature set must be an array.';
  if (material.asset === null || typeof material.asset !== 'object' || !material.asset.id?.trim())
    return 'Prepared material asset identity must be non-empty.';
  return undefined;
}

function validateContext(context: MaterialPipelineContext): void {
  if (!Number.isSafeInteger(context.deviceGeneration) || context.deviceGeneration < 0)
    throw new Error('Material pipeline device generation must be a non-negative safe integer.');
  if (!Number.isSafeInteger(context.sampleCount) || context.sampleCount < 1)
    throw new Error('Material pipeline sample count must be a positive safe integer.');
  for (const [name, value] of [
    ['semantic tag', context.semanticTag],
    ['FeaturePolicy hash', context.featurePolicyHash]
  ] as const) {
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Material pipeline ${name} must be non-empty.`);
  }
}

function buildPipelineKeyForCandidate(
  candidate: PreparedMeshQueueCandidate,
  material: PreparedMaterialCompatibility,
  selection: ResolvedMaterialPipelineCandidate['selection'],
  renderState: ResolvedMaterialPipelineCandidate['renderState'],
  context: MaterialPipelineContext
): ResolvedMaterialPipelineCandidate['pipelineKey'] {
  const meshLayout = candidate.mesh.prepared.value.layout;
  return createPipelineKey({
    shaderModuleKey: selection.technique.shader.moduleKey,
    entryPoints: [
      { stage: 'vertex', name: selection.technique.shader.vertexEntry },
      ...(selection.technique.shader.fragmentEntry === undefined
        ? []
        : [{ stage: 'fragment' as const, name: selection.technique.shader.fragmentEntry }])
    ],
    bindingLayoutHash: material.bindingLayoutHash,
    vertexLayoutHash: hashParts('vertex-layout', {
      streams: [...meshLayout.streams].sort(
        (left, right) =>
          left.bufferSlot - right.bufferSlot ||
          left.offset - right.offset ||
          compareCodeUnits(left.semantic, right.semantic)
      ),
      indexFormat: meshLayout.indexFormat ?? null
    }),
    primitiveStateHash: hashParts('primitive-state', {
      topology: meshLayout.topology,
      frontFace: meshLayout.frontFace,
      cullMode: renderState.cullMode
    }),
    depthStencilStateHash: hashParts('depth-stencil-state', {
      depthTest: renderState.depthTest,
      depthWrite: renderState.depthWrite,
      format: context.depthStencilFormat ?? null
    }),
    blendStateHash: hashParts('blend-state', {
      colorWrite: renderState.colorWrite,
      blend: renderState.blend ?? null
    }),
    attachmentFormats: context.attachmentFormats,
    ...(context.depthStencilFormat === undefined
      ? {}
      : { depthStencilFormat: context.depthStencilFormat }),
    sampleCount: context.sampleCount,
    featurePolicyHash: context.featurePolicyHash,
    deviceGeneration: context.deviceGeneration
  });
}

function skip(
  candidate: PreparedMeshQueueCandidate,
  code: MaterialPipelineCompatibilitySkip['code'],
  message: string,
  materialId?: string,
  technique?: string
): MaterialPipelineCompatibilitySkip {
  return Object.freeze({
    entity: candidate.entity,
    reason: 'incompatible-pipeline',
    code,
    diagnostic: Object.freeze({
      code,
      message,
      ...(materialId === undefined ? {} : { materialId }),
      ...(technique === undefined ? {} : { technique })
    })
  });
}

function hashParts(label: string, value: unknown): string {
  const canonical = JSON.stringify(value);
  return `${label}:${fnv1a32Hex(canonical)}`;
}

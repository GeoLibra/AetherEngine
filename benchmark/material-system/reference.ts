import type {
  BindingKeyParts,
  MaterialAsset,
  MaterialBlendIntent,
  MaterialCullMode,
  MaterialTechnique,
  MaterialTechniqueRequest,
  MaterialTechniqueRole,
  PipelineKeyParts,
  RenderPhaseKind
} from '../../src';
import type { MaterialScenarioObservation } from './types';

export interface ParameterReferenceInput {
  readonly fieldCount: number;
  readonly touchedInstances: number;
  readonly valueFor: (instanceIndex: number) => number;
}

export function runParameterSerializationReference(
  input: ParameterReferenceInput
): MaterialScenarioObservation {
  const byteSize = input.fieldCount * 4;
  const rangeCounts = new Array<number>(input.fieldCount).fill(0);
  let parameterChecksum = FNV_OFFSET;
  let revisionChecksum = FNV_OFFSET;

  for (let instanceIndex = 0; instanceIndex < input.touchedInstances; instanceIndex += 1) {
    const fieldIndex = instanceIndex % input.fieldCount;
    const bytes = new Uint8Array(byteSize);
    const view = new DataView(bytes.buffer);
    // The reference deliberately writes every reflected scalar, including unchanged defaults.
    for (let index = 0; index < input.fieldCount; index += 1) {
      view.setFloat32(index * 4, index === fieldIndex ? input.valueFor(instanceIndex) : 0, true);
    }
    parameterChecksum = hashBytes(bytes, parameterChecksum);
    revisionChecksum = hashInteger(1, revisionChecksum);
    rangeCounts[fieldIndex] = (rangeCounts[fieldIndex] ?? 0) + 1;
  }

  const semantic = parameterSemantic(parameterChecksum, revisionChecksum, rangeCounts);
  return observation(semantic, {
    touchedInstances: input.touchedInstances,
    fullBufferWrites: input.touchedInstances,
    uploadBytes: input.touchedInstances * byteSize,
    parameterBytesCopied: input.touchedInstances * byteSize,
    staleReuse: 0
  });
}

export interface PipelineReferenceInput {
  readonly asset: MaterialAsset;
  readonly request: MaterialTechniqueRequest;
  readonly pipelineParts: PipelineKeyParts;
  readonly bindingParts: BindingKeyParts;
  readonly instanceCount: number;
  readonly contextChurn: number;
  readonly resourceChurn: number;
}

export function runPipelineResolutionReference(
  input: PipelineReferenceInput
): MaterialScenarioObservation {
  let checksum = FNV_OFFSET;
  let canonicalBytesEncoded = 0;
  let candidateScans = 0;
  for (let index = 0; index < input.instanceCount; index += 1) {
    const facts = resolutionFacts(input, index);
    const selection = chooseReferenceTechnique(input.asset, input.request);
    const state = resolveReferenceRenderState(
      input.asset.renderState,
      { phase: input.request.phase, allowedOverrideRoles: input.request.allowedRoles },
      selection.status === 'unsupported' ? undefined : selection.technique
    );
    const pipelineCanonical = encodeReferencePipeline(facts.pipelineParts);
    const bindingCanonical = encodeReferenceBinding(facts.bindingParts);
    candidateScans += selection.candidatesExamined;
    canonicalBytesEncoded += pipelineCanonical.length + bindingCanonical.length;
    checksum = hashString(
      JSON.stringify({
        selection: summarizeReferenceSelection(selection),
        state,
        pipeline: pipelineCanonical,
        binding: bindingCanonical,
        diagnostics: selection.status === 'unsupported' ? [selection.diagnostic] : []
      }),
      checksum
    );
  }
  const semantic = pipelineSemantic(checksum, candidateScans, input.instanceCount);
  return observation(semantic, {
    candidateScans,
    renderStateResolutions: input.instanceCount,
    churnRebuilds: input.contextChurn + input.resourceChurn,
    canonicalBytesEncoded,
    staleReuse: 0
  });
}

export function resolutionFacts(input: PipelineReferenceInput, index: number) {
  const contextChanged = index < input.contextChurn;
  const resourceChanged =
    index >= input.contextChurn && index < input.contextChurn + input.resourceChurn;
  const deviceGeneration = contextChanged ? 2 + index : input.pipelineParts.deviceGeneration;
  const resourceGeneration = resourceChanged
    ? 2 + index - input.contextChurn
    : (input.bindingParts.resources[0]?.resourceGeneration ?? 1);
  return {
    pipelineParts: {
      ...input.pipelineParts,
      deviceGeneration
    },
    bindingParts: {
      ...input.bindingParts,
      deviceGeneration,
      resources: input.bindingParts.resources.map((resource, resourceIndex) =>
        resourceIndex === 0 ? { ...resource, resourceGeneration } : resource
      )
    },
    resourceChanged
  };
}

export function parameterSemantic(
  parameterChecksum: number,
  revisionChecksum: number,
  rangeCounts: readonly number[]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    parameterChecksum: hex(parameterChecksum),
    revisionChecksum: hex(revisionChecksum),
    dirtyRanges: Object.freeze(
      rangeCounts.flatMap((count, index) =>
        count === 0 ? [] : [Object.freeze({ offset: index * 4, byteLength: 4, count })]
      )
    ),
    diagnostics: Object.freeze([])
  });
}

export function pipelineSemantic(
  checksum: number,
  candidateScans: number,
  renderStateResolutions: number
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    resolutionChecksum: hex(checksum),
    candidateScans,
    renderStateResolutions,
    diagnostics: Object.freeze([])
  });
}

export function observation(
  semantic: Readonly<Record<string, unknown>>,
  counters: Readonly<Record<string, number>>
): MaterialScenarioObservation {
  return Object.freeze({
    checksum: hex(hashString(JSON.stringify(semantic), FNV_OFFSET)),
    semantic,
    counters: Object.freeze({ ...counters })
  });
}

export const FNV_OFFSET = 0x811c9dc5;

export function hashBytes(bytes: Uint8Array, initial: number): number {
  let hash = initial;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashInteger(value: number, initial: number): number {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return hashBytes(bytes, initial);
}

export function hashString(value: string, initial: number): number {
  return hashBytes(new TextEncoder().encode(value), initial);
}

type ReferenceSelection =
  | Readonly<{
      status: 'selected' | 'fallback';
      technique: MaterialTechnique;
      requestedRole: MaterialTechniqueRole;
      selectedRole: MaterialTechniqueRole;
      fallbackReason?: string;
      candidatesExamined: number;
    }>
  | Readonly<{
      status: 'unsupported';
      candidatesExamined: number;
      diagnostic: Readonly<{
        code: 'no-compatible-technique';
        materialId: string;
        schemaId: string;
        schemaVersion: number;
        message: string;
        reasons: readonly string[];
      }>;
    }>;

function chooseReferenceTechnique(
  asset: MaterialAsset,
  request: MaterialTechniqueRequest
): ReferenceSelection {
  const requestedRole = request.allowedRoles[0];
  if (requestedRole === undefined) return unsupportedReference(asset, 0, ['No role requested.']);
  let candidatesExamined = 0;
  for (const technique of referenceCandidates(asset.techniques, requestedRole)) {
    candidatesExamined += 1;
    if (referenceCompatible(technique, request)) {
      return Object.freeze({
        status: 'selected',
        technique,
        requestedRole,
        selectedRole: technique.passRole,
        candidatesExamined
      });
    }
  }
  for (const role of request.allowedRoles.slice(1)) {
    for (const technique of referenceCandidates(asset.techniques, role)) {
      if (!technique.fallbackFor?.includes(requestedRole)) continue;
      candidatesExamined += 1;
      if (referenceCompatible(technique, request)) {
        return Object.freeze({
          status: 'fallback',
          technique,
          requestedRole,
          selectedRole: technique.passRole,
          fallbackReason: `No compatible exact ${requestedRole} technique; using declared ${role} fallback.`,
          candidatesExamined
        });
      }
    }
  }
  return unsupportedReference(asset, candidatesExamined, [
    `No compatible exact ${requestedRole} technique.`,
    'No explicitly declared compatible fallback was available.'
  ]);
}

function unsupportedReference(
  asset: MaterialAsset,
  candidatesExamined: number,
  reasons: readonly string[]
): ReferenceSelection {
  return Object.freeze({
    status: 'unsupported',
    candidatesExamined,
    diagnostic: Object.freeze({
      code: 'no-compatible-technique',
      materialId: asset.id,
      schemaId: asset.schema.id,
      schemaVersion: asset.schema.version,
      message: reasons.join(' '),
      reasons: Object.freeze([...reasons])
    })
  });
}

function referenceCandidates(
  techniques: readonly MaterialTechnique[],
  role: MaterialTechniqueRole
): MaterialTechnique[] {
  return techniques
    .filter((technique) => technique.passRole === role)
    .sort((left, right) => right.priority - left.priority || compareText(left.name, right.name));
}

function referenceCompatible(
  technique: MaterialTechnique,
  request: MaterialTechniqueRequest
): boolean {
  const compatibility = technique.compatibility;
  return (
    compatibility.semanticTag === request.semanticTag &&
    compatibility.bindingLayoutHash === request.bindingLayoutHash &&
    subset(compatibility.requiredFeatures, request.availableFeatures) &&
    subset(compatibility.requiredMaterialFeatures, request.availableMaterialFeatures) &&
    subset(compatibility.requiredViewFeatures, request.availableViewFeatures) &&
    subset(compatibility.requiredMeshCapabilities, request.availableMeshCapabilities) &&
    sameValues(compatibility.attachmentFormats, request.attachmentFormats) &&
    (request.depthStencilFormat === undefined
      ? compatibility.depthStencilFormats.length === 0
      : compatibility.depthStencilFormats.includes(request.depthStencilFormat)) &&
    compatibility.sampleCounts.includes(request.sampleCount)
  );
}

function resolveReferenceRenderState(
  intent: MaterialAsset['renderState'],
  phaseContext: Readonly<{
    phase: RenderPhaseKind;
    allowedOverrideRoles: readonly MaterialTechniqueRole[];
  }>,
  technique?: MaterialTechnique
) {
  const surface = intent.surface ?? 'opaque';
  if (surface === 'alpha-mask' && phaseContext.phase === 'transparent') {
    return Object.freeze({
      status: 'conflict' as const,
      diagnostic: Object.freeze({
        code: 'render-state-conflict' as const,
        message: 'Alpha-mask material intent cannot be resolved in the transparent phase.'
      })
    });
  }
  let state: {
    depthTest: boolean;
    depthWrite: boolean;
    colorWrite: boolean;
    cullMode: MaterialCullMode;
    blend: MaterialBlendIntent | undefined;
  } = {
    depthTest: intent.depthTest ?? true,
    depthWrite: intent.depthWrite ?? true,
    colorWrite: intent.colorWrite ?? true,
    cullMode: intent.cullMode ?? 'back',
    blend: intent.blend
  };
  if (phaseContext.phase === 'transparent') {
    state = { ...state, depthTest: true, depthWrite: false };
  }
  const override = technique?.renderStateOverride;
  if (override !== undefined && Object.keys(override).length > 0) {
    if (technique === undefined) throw new Error('Reference technique override invariant failed.');
    if (!phaseContext.allowedOverrideRoles.includes(technique.passRole)) {
      return Object.freeze({
        status: 'conflict' as const,
        diagnostic: Object.freeze({
          code: 'render-state-conflict' as const,
          message: `Technique role "${technique.passRole}" is not allowed to override this phase state.`
        })
      });
    }
    state = {
      depthTest: override.depthTest ?? state.depthTest,
      depthWrite: override.depthWrite ?? state.depthWrite,
      colorWrite: override.colorWrite ?? state.colorWrite,
      cullMode: override.cullMode ?? state.cullMode,
      blend: override.blend ?? state.blend
    };
  }
  return Object.freeze({
    status: 'resolved' as const,
    phase: phaseContext.phase,
    surface,
    ...state,
    blend: state.blend === undefined ? undefined : Object.freeze({ ...state.blend })
  });
}

function encodeReferencePipeline(parts: PipelineKeyParts): string {
  const entryPoints = [...parts.entryPoints].sort(
    (left, right) => referenceStageOrder(left.stage) - referenceStageOrder(right.stage)
  );
  return JSON.stringify({
    shaderModuleKey: parts.shaderModuleKey,
    entryPoints: entryPoints.map((entry) => ({ ...entry })),
    bindingLayoutHash: parts.bindingLayoutHash,
    vertexLayoutHash: parts.vertexLayoutHash,
    primitiveStateHash: parts.primitiveStateHash,
    depthStencilStateHash: parts.depthStencilStateHash,
    blendStateHash: parts.blendStateHash,
    attachmentFormats: [...parts.attachmentFormats],
    ...(parts.depthStencilFormat === undefined
      ? {}
      : { depthStencilFormat: parts.depthStencilFormat }),
    sampleCount: parts.sampleCount,
    featurePolicyHash: parts.featurePolicyHash,
    deviceGeneration: parts.deviceGeneration
  });
}

function encodeReferenceBinding(parts: BindingKeyParts): string {
  const resources = [...parts.resources].sort(
    (left, right) =>
      left.group - right.group ||
      left.binding - right.binding ||
      compareText(left.assetId, right.assetId)
  );
  return JSON.stringify({
    bindingLayoutHash: parts.bindingLayoutHash,
    resources: resources.map((resource) => ({ ...resource })),
    bufferAllocationGeneration: parts.bufferAllocationGeneration,
    ringGeneration: parts.ringGeneration,
    dynamicOffsets: [...parts.dynamicOffsets],
    deviceGeneration: parts.deviceGeneration
  });
}

function summarizeReferenceSelection(selection: ReferenceSelection) {
  return selection.status === 'unsupported'
    ? {
        status: selection.status,
        candidatesExamined: selection.candidatesExamined,
        diagnostic: selection.diagnostic
      }
    : {
        status: selection.status,
        technique: selection.technique.name,
        selectedRole: selection.selectedRole,
        candidatesExamined: selection.candidatesExamined
      };
}

function subset(required: readonly string[], available: readonly string[]): boolean {
  const values = new Set(available);
  return required.every((value) => values.has(value));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function referenceStageOrder(stage: 'vertex' | 'fragment'): number {
  return stage === 'vertex' ? 0 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

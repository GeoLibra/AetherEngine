import {
  SubmissionRetainedCache,
  compileMaterialParameterLayout,
  createBindingKey,
  createMaterialAsset,
  createMaterialInstance,
  createMaterialTechniqueRole,
  createPipelineKey,
  defineMaterialSchema,
  getMaterialMetrics,
  resetMaterialMetrics,
  resolveMaterialAsset,
  resolveMaterialRenderState,
  selectMaterialTechnique,
  writeMaterialParameters,
  type BindingKeyParts,
  type BufferLayoutManifest,
  type CanonicalKey,
  type MaterialAsset,
  type MaterialFieldDefinitions,
  type MaterialTechniqueRequest,
  type PipelineKeyParts
} from '../../src';
import {
  FNV_OFFSET,
  hashBytes,
  hashInteger,
  hashString,
  observation,
  parameterSemantic,
  pipelineSemantic,
  resolutionFacts,
  runParameterSerializationReference,
  runPipelineResolutionReference,
  type PipelineReferenceInput
} from './reference';
import type {
  MaterialBenchmarkProfileName,
  MaterialScenarioCase,
  MaterialScenarioObservation
} from './types';
import { createMaterialPipelineCompatibilityCase } from './compatibility-scenario';
import { createMaterialBindingCompatibilityCase } from './binding-compatibility-scenario';

export interface ParameterEditUploadOptions {
  readonly fieldCount: 8 | 32 | 64;
  readonly instanceCount: number;
  readonly dirtyFraction: 0.01 | 0.1 | 1;
  readonly seed: number;
}

export interface PipelineBindingResolutionOptions {
  readonly instanceCount: number;
  readonly contextChurn: number;
  readonly resourceChurn: number;
  readonly seed: number;
}

export interface PipelineSubjectOperations {
  readonly selectTechnique: typeof selectMaterialTechnique;
  readonly resolveRenderState: typeof resolveMaterialRenderState;
  readonly createPipelineKey: typeof createPipelineKey;
  readonly createBindingKey: typeof createBindingKey;
}

export const PIPELINE_SUBJECT_OPERATIONS: PipelineSubjectOperations = Object.freeze({
  selectTechnique: selectMaterialTechnique,
  resolveRenderState: resolveMaterialRenderState,
  createPipelineKey,
  createBindingKey
});

export function createMaterialScenarioCases(
  profile: MaterialBenchmarkProfileName,
  instanceCounts: readonly number[],
  seed: number
): readonly MaterialScenarioCase[] {
  const parameterCases = instanceCounts.flatMap((instanceCount) =>
    ([8, 32, 64] as const).flatMap((fieldCount) =>
      ([0.01, 0.1, 1] as const).map((dirtyFraction) =>
        createParameterEditUploadCase({ fieldCount, instanceCount, dirtyFraction, seed })
      )
    )
  );
  const pipelineCases = instanceCounts.map((instanceCount) =>
    createPipelineBindingResolutionCase({
      instanceCount,
      contextChurn: Math.max(1, Math.floor(instanceCount * (profile === 'smoke' ? 0.02 : 0.01))),
      resourceChurn: Math.max(1, Math.floor(instanceCount * (profile === 'nightly' ? 0.02 : 0.01))),
      seed
    })
  );
  const compatibilityCases = instanceCounts.map((instanceCount) =>
    createMaterialPipelineCompatibilityCase({
      instanceCount,
      uniqueMeshLayouts: Math.min(256, Math.max(16, Math.floor(instanceCount / 10))),
      seed
    })
  );
  const bindingCompatibilityCases = instanceCounts.map((instanceCount) =>
    createMaterialBindingCompatibilityCase({ instanceCount })
  );
  return Object.freeze([
    ...parameterCases,
    ...pipelineCases,
    ...compatibilityCases,
    ...bindingCompatibilityCases
  ]);
}

export { createMaterialPipelineCompatibilityCase } from './compatibility-scenario';
export { createMaterialBindingCompatibilityCase } from './binding-compatibility-scenario';

export function createParameterEditUploadCase(
  options: ParameterEditUploadOptions
): MaterialScenarioCase {
  const touchedInstances = Math.max(1, Math.floor(options.instanceCount * options.dirtyFraction));
  const fixture = createParameterFixture(options.fieldCount);
  const byteSize = options.fieldCount * 4;
  const expectedReference = Object.freeze({
    touchedInstances,
    fullBufferWrites: touchedInstances,
    uploadBytes: touchedInstances * byteSize,
    parameterBytesCopied: touchedInstances * byteSize,
    staleReuse: 0
  });
  const expectedSubject = Object.freeze({
    touchedInstances,
    fullBufferWrites: 0,
    uploadBytes: touchedInstances * 4,
    blocksCloned: touchedInstances,
    valuesSnapshotted: touchedInstances,
    parameterBytesCopied: touchedInstances * byteSize,
    staleReuse: 0
  });
  return Object.freeze({
    scenarioId: 'parameter-edit-upload-v1',
    scenarioVersion: 1,
    caseId: `fields-${options.fieldCount}-instances-${options.instanceCount}-dirty-${options.dirtyFraction}`,
    scale: Object.freeze({
      fieldCount: options.fieldCount,
      instanceCount: options.instanceCount,
      dirtyFraction: options.dirtyFraction,
      touchedInstances
    }),
    expected: Object.freeze({ reference: expectedReference, subject: expectedSubject }),
    runReference: () =>
      runParameterSerializationReference({
        fieldCount: options.fieldCount,
        touchedInstances,
        valueFor: (index) => valueFor(options.seed, index)
      }),
    runSubject: () => runParameterSubject(fixture, touchedInstances, options.seed)
  });
}

export function createPipelineBindingResolutionCase(
  options: PipelineBindingResolutionOptions,
  subjectOperations: PipelineSubjectOperations = PIPELINE_SUBJECT_OPERATIONS
): MaterialScenarioCase {
  const fixture = createPipelineFixture(options);
  const reference = runPipelineResolutionReference(fixture);
  const uniqueEntries = 1 + options.contextChurn + options.resourceChurn;
  const expectedReference = Object.freeze({
    candidateScans: options.instanceCount,
    renderStateResolutions: options.instanceCount,
    churnRebuilds: options.contextChurn + options.resourceChurn,
    canonicalBytesEncoded: reference.counters.canonicalBytesEncoded ?? 0,
    staleReuse: 0
  });
  const expectedSubject = Object.freeze({
    candidateScans: options.instanceCount,
    renderStateResolutions: options.instanceCount,
    churnRebuilds: options.contextChurn + options.resourceChurn,
    cacheMisses: uniqueEntries + options.contextChurn + options.resourceChurn,
    canonicalBytesEncoded: reference.counters.canonicalBytesEncoded ?? 0,
    cacheEntriesCreated: uniqueEntries,
    staleGenerationMisses: options.contextChurn + options.resourceChurn,
    policyEntriesRetired: 1 + options.contextChurn,
    policyEntriesDestroyed: 1 + options.contextChurn,
    staleHitRejected: 0,
    staleReuse: 0
  });
  return Object.freeze({
    scenarioId: 'pipeline-binding-resolution-v1',
    scenarioVersion: 1,
    caseId: `instances-${options.instanceCount}-context-${options.contextChurn}-resource-${options.resourceChurn}`,
    scale: Object.freeze({ ...options }),
    expected: Object.freeze({ reference: expectedReference, subject: expectedSubject }),
    runReference: () => runPipelineResolutionReference(fixture),
    runSubject: () => runPipelineSubject(fixture, subjectOperations)
  });
}

function runParameterSubject(
  fixture: ReturnType<typeof createParameterFixture>,
  touchedInstances: number,
  seed: number
): MaterialScenarioObservation {
  resetMaterialMetrics();
  const initialWrite = writeMaterialParameters(fixture.layout, fixture.instance.parameters);
  const rangeCounts = new Array<number>(fixture.fields.length).fill(0);
  let parameterChecksum = FNV_OFFSET;
  let revisionChecksum = FNV_OFFSET;
  let uploadBytes = 0;

  for (let instanceIndex = 0; instanceIndex < touchedInstances; instanceIndex += 1) {
    const field = fixture.fields[instanceIndex % fixture.fields.length];
    if (field === undefined) throw new Error('Material benchmark field fixture is incomplete.');
    const next = fixture.instance.edit((draft) => draft.set(field, valueFor(seed, instanceIndex)));
    const write = writeMaterialParameters(fixture.layout, next.parameters, initialWrite);
    parameterChecksum = hashBytes(write.bytes, parameterChecksum);
    revisionChecksum = hashInteger(next.revision, revisionChecksum);
    uploadBytes += write.counters.writtenBytes;
    for (const range of write.dirtyRanges) {
      const rangeIndex = range.offset / 4;
      rangeCounts[rangeIndex] = (rangeCounts[rangeIndex] ?? 0) + 1;
    }
  }
  const metrics = getMaterialMetrics();
  return observation(parameterSemantic(parameterChecksum, revisionChecksum, rangeCounts), {
    touchedInstances,
    fullBufferWrites: 0,
    uploadBytes,
    blocksCloned: metrics.blocksCloned,
    valuesSnapshotted: metrics.valuesSnapshotted,
    parameterBytesCopied: touchedInstances * fixture.layout.byteSize,
    staleReuse: 0
  });
}

function runPipelineSubject(
  input: PipelineReferenceInput,
  operations: PipelineSubjectOperations
): MaterialScenarioObservation {
  const bindingCache = new SubmissionRetainedCache<number>();
  const pipelineCache = new SubmissionRetainedCache<number>();
  let checksum = FNV_OFFSET;
  let canonicalBytesEncoded = 0;
  let candidateScans = 0;
  let staleGenerationMisses = 0;
  let staleReuse = 0;
  let previousKey: CanonicalKey<BindingKeyParts> | undefined;
  for (let index = 0; index < input.instanceCount; index += 1) {
    const facts = resolutionFacts(input, index);
    const selection = operations.selectTechnique(input.asset, input.request);
    const state = operations.resolveRenderState(
      input.asset.renderState,
      { phase: input.request.phase, allowedOverrideRoles: input.request.allowedRoles },
      selection.status === 'unsupported' ? undefined : selection.technique
    );
    const pipelineKey = operations.createPipelineKey(facts.pipelineParts);
    const bindingKey = operations.createBindingKey(facts.bindingParts);
    let pipelineLease = pipelineCache.acquire(pipelineKey);
    if (pipelineLease === undefined) {
      pipelineCache.publish(pipelineKey, index);
      pipelineLease = pipelineCache.acquire(pipelineKey);
    }
    pipelineLease?.release();
    if (previousKey !== undefined && previousKey.canonicalValue !== bindingKey.canonicalValue) {
      bindingCache.retire(previousKey);
      const staleLease = bindingCache.acquire(previousKey);
      if (staleLease === undefined) {
        staleGenerationMisses += 1;
      } else {
        staleReuse += 1;
        staleLease.release();
      }
    }
    let lease = bindingCache.acquire(bindingKey);
    if (lease === undefined) {
      bindingCache.publish(bindingKey, index);
      lease = bindingCache.acquire(bindingKey);
    }
    lease?.release();
    previousKey = bindingKey;
    candidateScans += selection.candidatesExamined;
    canonicalBytesEncoded += pipelineKey.canonicalValue.length + bindingKey.canonicalValue.length;
    checksum = hashString(
      JSON.stringify({
        selection:
          selection.status === 'unsupported'
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
              },
        state,
        pipeline: pipelineKey.canonicalValue,
        binding: bindingKey.canonicalValue,
        diagnostics: selection.status === 'unsupported' ? [selection.diagnostic] : []
      }),
      checksum
    );
  }
  pipelineCache.invalidateFeaturePolicy({
    domain: 'shader-pipeline',
    previousHash: input.pipelineParts.featurePolicyHash,
    nextHash: `${input.pipelineParts.featurePolicyHash}-next`
  });
  const metrics = bindingCache.metrics();
  const pipelineMetrics = pipelineCache.metrics();
  return observation(pipelineSemantic(checksum, candidateScans, input.instanceCount), {
    candidateScans,
    renderStateResolutions: input.instanceCount,
    churnRebuilds: input.contextChurn + input.resourceChurn,
    cacheMisses: metrics.misses,
    canonicalBytesEncoded,
    cacheEntriesCreated: metrics.published,
    staleGenerationMisses,
    policyEntriesRetired: pipelineMetrics.retired,
    policyEntriesDestroyed: pipelineMetrics.destroyed,
    staleHitRejected: metrics.staleHitRejected,
    staleReuse: staleReuse + metrics.staleReuse
  });
}

function createParameterFixture(fieldCount: number) {
  const definitions = Object.fromEntries(
    Array.from({ length: fieldCount }, (_, index) => [
      `field${index}`,
      {
        fieldId: `field-${index}`,
        name: `field${index}`,
        valueType: { kind: 'number' as const, format: 'f32' as const },
        defaultValue: 0,
        bindingPath: `parameters.field${index}`
      }
    ])
  ) as MaterialFieldDefinitions;
  const schema = defineMaterialSchema({
    id: `benchmark-${fieldCount}`,
    version: 1,
    fields: definitions
  });
  const manifest: BufferLayoutManifest = {
    name: 'Parameters',
    shaderAbiVersion: 1,
    target: 'wgsl',
    addressSpace: 'uniform',
    access: 'read',
    policy: 'wgsl-uniform',
    byteSize: fieldCount * 4,
    alignment: 4,
    fields: Array.from({ length: fieldCount }, (_, index) => ({
      path: `parameters.field${index}`,
      offset: index * 4,
      size: 4,
      alignment: 4,
      scalarKind: 'f32' as const,
      elementCount: 1,
      shape: { kind: 'scalar' as const }
    })),
    layoutHash: `material-benchmark-${fieldCount}`
  };
  const asset = createMaterialAsset({
    id: `benchmark-${fieldCount}`,
    version: 1,
    schema,
    techniques: [],
    renderState: { surface: 'opaque' }
  });
  const instance = createMaterialInstance(
    resolveMaterialAsset({ assetId: asset.id, payloadVersion: asset.version }, asset)
  );
  return {
    layout: compileMaterialParameterLayout(schema, manifest),
    instance,
    fields: Object.values(schema.fields)
  };
}

function createPipelineFixture(options: PipelineBindingResolutionOptions): PipelineReferenceInput {
  const role = createMaterialTechniqueRole('forward');
  const schema = defineMaterialSchema({
    id: 'benchmark-pipeline',
    version: 1,
    fields: {
      roughness: {
        fieldId: 'roughness',
        name: 'roughness',
        valueType: { kind: 'number', format: 'f32' },
        defaultValue: 0.5,
        bindingPath: 'parameters.roughness'
      }
    }
  });
  const asset: MaterialAsset = createMaterialAsset({
    id: 'benchmark-pipeline',
    version: 1,
    schema,
    techniques: [
      {
        name: 'forward-main',
        passRole: role,
        shader: { moduleKey: 'shader', vertexEntry: 'vs', fragmentEntry: 'fs' },
        priority: 1,
        compatibility: {
          semanticTag: 'lit',
          bindingLayoutHash: 'layout',
          requiredFeatures: [],
          requiredMaterialFeatures: [],
          requiredViewFeatures: [],
          requiredMeshCapabilities: [],
          attachmentFormats: ['rgba16float'],
          depthStencilFormats: ['depth24plus'],
          sampleCounts: [1]
        }
      }
    ],
    renderState: { surface: 'opaque', cullMode: 'back' }
  });
  const request: MaterialTechniqueRequest = {
    phase: 'opaque',
    allowedRoles: [role],
    availableFeatures: [],
    availableMaterialFeatures: [],
    availableViewFeatures: [],
    availableMeshCapabilities: [],
    bindingLayoutHash: 'layout',
    attachmentFormats: ['rgba16float'],
    depthStencilFormat: 'depth24plus',
    sampleCount: 1,
    semanticTag: 'lit'
  };
  const pipelineParts: PipelineKeyParts = {
    shaderModuleKey: 'shader',
    entryPoints: [
      { stage: 'vertex', name: 'vs' },
      { stage: 'fragment', name: 'fs' }
    ],
    bindingLayoutHash: 'layout',
    vertexLayoutHash: 'vertex',
    primitiveStateHash: 'triangles',
    depthStencilStateHash: 'depth-test-write',
    blendStateHash: 'opaque',
    attachmentFormats: ['rgba16float'],
    depthStencilFormat: 'depth24plus',
    sampleCount: 1,
    featurePolicyHash: `fixed-${options.seed}`,
    deviceGeneration: 1
  };
  const bindingParts: BindingKeyParts = {
    bindingLayoutHash: 'layout',
    resources: [
      {
        group: 0,
        binding: 1,
        assetId: 'albedo',
        assetPayloadVersion: 1,
        resourceGeneration: 1
      }
    ],
    bufferAllocationGeneration: 1,
    ringGeneration: 1,
    dynamicOffsets: [0],
    deviceGeneration: 1
  };
  return {
    asset,
    request,
    pipelineParts,
    bindingParts,
    instanceCount: options.instanceCount,
    contextChurn: options.contextChurn,
    resourceChurn: options.resourceChurn
  };
}

function valueFor(seed: number, index: number): number {
  return (((seed + index * 17) % 10_000) + 1) / 10_000;
}

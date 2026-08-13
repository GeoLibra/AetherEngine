import { describe, expect, test } from 'vitest';
import {
  createMaterialResolutionRecord,
  createMaterialTechniqueRole,
  createPipelineKey,
  resolveMaterialRenderState,
  type MaterialResolutionRecordFacts,
  type MaterialRenderStateIntent,
  type MaterialShaderEntryRef,
  type MaterialSurfaceKind,
  type MaterialTechnique,
  type ShaderDiagnostic
} from '../../src';

const forward = createMaterialTechniqueRole('forward');
const shadow = createMaterialTechniqueRole('shadow');

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type MaterialRenderStateIntentKeys = Expect<
  Equal<
    keyof MaterialRenderStateIntent,
    'surface' | 'depthTest' | 'depthWrite' | 'colorWrite' | 'cullMode' | 'blend'
  >
>;

const exactMaterialRenderStateIntent: MaterialRenderStateIntentKeys = true;

function overrideTechnique(
  passRole = forward,
  renderStateOverride: MaterialTechnique['renderStateOverride'] = {}
): MaterialTechnique {
  return {
    name: 'override',
    passRole,
    shader: { moduleKey: 'shader', vertexEntry: 'vs', fragmentEntry: 'fs' },
    priority: 0,
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
    },
    renderStateOverride
  };
}

describe('Material render-state resolution', () => {
  test('keeps material render-state intent exact', () => {
    expect(exactMaterialRenderStateIntent).toBe(true);
  });

  test('preserves alpha-mask semantics in its requested non-transparent phase', () => {
    const result = resolveMaterialRenderState(
      { surface: 'alpha-mask', cullMode: 'back' },
      { phase: 'alpha-test', defaults: { depthTest: true, depthWrite: true } }
    );

    expect(result).toEqual({
      status: 'resolved',
      phase: 'alpha-test',
      surface: 'alpha-mask',
      depthTest: true,
      depthWrite: true,
      colorWrite: true,
      cullMode: 'back',
      blend: undefined
    });
  });

  test('applies transparent depth defaults while preserving its declared blend', () => {
    const intent: MaterialRenderStateIntent = {
      surface: 'transparent',
      depthWrite: true,
      blend: { color: 'source-over', alpha: 'source-over' }
    };
    const result = resolveMaterialRenderState(intent, { phase: 'transparent' });

    expect(result).toMatchObject({
      status: 'resolved',
      depthTest: true,
      depthWrite: false,
      blend: { color: 'source-over', alpha: 'source-over' }
    });
  });

  test('uses asset intent then phase context then a role-allowed explicit override', () => {
    const result = resolveMaterialRenderState(
      { surface: 'opaque', depthTest: false, depthWrite: false, cullMode: 'back' },
      {
        phase: 'opaque',
        defaults: { depthTest: true, depthWrite: true },
        allowedOverrideRoles: [forward]
      },
      overrideTechnique(forward, { depthWrite: false, cullMode: 'none' })
    );

    expect(result).toMatchObject({
      status: 'resolved',
      depthTest: true,
      depthWrite: false,
      cullMode: 'none'
    });
    expect(JSON.stringify(result)).not.toMatch(/GPU|RHI|device/i);
  });

  test('reports alpha-mask phase and role-incompatible override conflicts structurally', () => {
    const wrongPhase = resolveMaterialRenderState(
      { surface: 'alpha-mask' },
      { phase: 'transparent' }
    );
    const wrongRole = resolveMaterialRenderState(
      { surface: 'opaque' },
      { phase: 'opaque', allowedOverrideRoles: [forward] },
      overrideTechnique(shadow, { colorWrite: false })
    );

    expect(wrongPhase).toMatchObject({
      status: 'conflict',
      diagnostic: { code: 'render-state-conflict' }
    });
    expect(wrongRole).toMatchObject({
      status: 'conflict',
      diagnostic: { code: 'render-state-conflict' }
    });
  });

  test('changes shadow color-write and cull only through an explicit compatible override', () => {
    const base: MaterialRenderStateIntent = {
      surface: 'opaque',
      colorWrite: true,
      cullMode: 'back'
    };
    const unchanged = resolveMaterialRenderState(base, {
      phase: 'shadow',
      allowedOverrideRoles: [shadow]
    });
    const overridden = resolveMaterialRenderState(
      base,
      { phase: 'shadow', allowedOverrideRoles: [shadow] },
      overrideTechnique(shadow, { colorWrite: false, cullMode: 'front' })
    );

    expect(unchanged).toMatchObject({ status: 'resolved', colorWrite: true, cullMode: 'back' });
    expect(overridden).toMatchObject({ status: 'resolved', colorWrite: false, cullMode: 'front' });
  });
});

describe('Material resolution observability', () => {
  test('creates a deeply immutable debug snapshot only on explicit demand', () => {
    const pipelineKey = createPipelineKey({
      shaderModuleKey: 'shader',
      entryPoints: [
        { stage: 'vertex', name: 'main' },
        { stage: 'fragment', name: 'main' }
      ],
      bindingLayoutHash: 'layout',
      vertexLayoutHash: 'vertex',
      primitiveStateHash: 'primitive',
      depthStencilStateHash: 'depth',
      blendStateHash: 'blend',
      attachmentFormats: ['rgba16float'],
      depthStencilFormat: 'depth24plus',
      sampleCount: 1,
      featurePolicyHash: 'desktop',
      deviceGeneration: 3
    });
    const lastCompileDiagnostic: ShaderDiagnostic = {
      severity: 'warning',
      code: 'shader/last-good',
      message: 'last-good variant retained',
      stage: 'cache',
      primary: { uri: 'asset://shader/material', line: 1, column: 1, length: 1 },
      related: []
    };
    const surface: MaterialSurfaceKind = 'opaque';
    const shaderEntry: MaterialShaderEntryRef = {
      moduleKey: 'shader',
      vertexEntry: 'main',
      fragmentEntry: 'main'
    };
    const missingBindings = ['shadowMap'];
    const facts: MaterialResolutionRecordFacts = {
      selectedTechnique: 'forward-main',
      selectedVariant: 'normal-map',
      pipelineKeyParts: pipelineKey.parts,
      cacheOutcome: 'miss' as const,
      fallbackReason: 'gbuffer unsupported',
      missingBindings,
      parameterUploadBytes: 64,
      lastCompileDiagnostic
    };
    const invalidFacts: MaterialResolutionRecordFacts = {
      ...facts,
      // @ts-expect-error Compile diagnostics must use the complete Shader diagnostic contract.
      lastCompileDiagnostic: { code: 'warning', message: 'incomplete diagnostic' }
    };

    const record = createMaterialResolutionRecord(facts);
    missingBindings.push('mutated-after-snapshot');

    expect(record).toMatchObject({
      selectedTechnique: 'forward-main',
      selectedVariant: 'normal-map',
      pipelineKeyParts: { deviceGeneration: 3 },
      cacheOutcome: 'miss',
      fallbackReason: 'gbuffer unsupported',
      missingBindings: ['shadowMap'],
      parameterUploadBytes: 64,
      lastCompileDiagnostic: { code: 'shader/last-good', severity: 'warning' }
    });
    expect(surface).toBe('opaque');
    expect(shaderEntry.moduleKey).toBe('shader');
    expect(invalidFacts.lastCompileDiagnostic).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.pipelineKeyParts)).toBe(true);
    expect(Object.isFrozen(record.missingBindings)).toBe(true);
    expect(Object.isFrozen(record.lastCompileDiagnostic)).toBe(true);
  });
});

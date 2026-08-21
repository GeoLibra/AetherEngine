import { describe, expect, test } from 'vitest';
import {
  PreparedAssetRegistry,
  createMaterialAsset,
  createMaterialTechniqueRole,
  defineMaterialSchema,
  resolveMaterialPipelineCompatibility,
  type MaterialPipelineCompatibilitySkipCode,
  type MaterialPipelineContext,
  type MaterialTechnique,
  type PreparedMaterialCompatibility,
  type PreparedMesh,
  type PreparedMeshStreamLayout,
  type PreparedMeshQueueCandidate,
  type PreparedVariantKey,
  type RenderEntityId
} from '../../src';

const gbuffer = createMaterialTechniqueRole('gbuffer');
const forward = createMaterialTechniqueRole('forward');

function context(changes: Partial<MaterialPipelineContext> = {}): MaterialPipelineContext {
  return {
    phase: 'opaque',
    allowedRoles: [gbuffer, forward],
    availableFeatures: ['compressed-textures'],
    availableMeshCapabilities: ['positions'],
    availableViewFeatures: ['fog'],
    attachmentFormats: ['rgba16float'],
    depthStencilFormat: 'depth24plus',
    sampleCount: 1,
    semanticTag: 'lit-surface',
    featurePolicyHash: 'policy:webgpu-baseline',
    deviceGeneration: 3,
    ...changes
  };
}

function technique(
  name: string,
  role = gbuffer,
  changes: Partial<MaterialTechnique> = {}
): MaterialTechnique {
  return {
    name,
    passRole: role,
    shader: { moduleKey: `shader:${name}`, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
    priority: 0,
    compatibility: {
      semanticTag: 'lit-surface',
      bindingLayoutHash: 'layout:pbr-v1',
      requiredFeatures: ['compressed-textures'],
      requiredMaterialFeatures: ['base-color'],
      requiredViewFeatures: ['fog'],
      requiredMeshCapabilities: ['positions'],
      attachmentFormats: ['rgba16float'],
      depthStencilFormats: ['depth24plus'],
      sampleCounts: [1]
    },
    ...changes
  };
}

function candidate(
  options: {
    readonly techniques?: readonly MaterialTechnique[];
    readonly layoutHash?: string;
    readonly deviceGeneration?: number;
    readonly streamSemantic?: string;
    readonly streams?: readonly PreparedMeshStreamLayout[];
  } = {}
): { readonly value: PreparedMeshQueueCandidate; readonly dispose: () => void } {
  const deviceGeneration = options.deviceGeneration ?? 3;
  const schema = defineMaterialSchema({ id: 'material.pipeline-test', version: 1, fields: {} });
  const asset = createMaterialAsset({
    id: 'material:pipeline-test',
    version: 1,
    schema,
    techniques: options.techniques ?? [technique('exact')],
    renderState: { surface: 'opaque', cullMode: 'back' }
  });
  const mesh: PreparedMesh = {
    deviceGeneration,
    layout: {
      topology: 'triangles',
      frontFace: 'ccw',
      streams: options.streams ?? [
        {
          semantic: options.streamSemantic ?? 'POSITION',
          format: 'float32x3',
          stride: 12,
          offset: 0,
          bufferSlot: 0
        }
      ]
    },
    vertexBuffers: [],
    submeshes: [{ start: 0, count: 3, materialSlot: 0 }],
    byteLength: 0
  };
  const material: PreparedMaterialCompatibility = {
    deviceGeneration,
    asset,
    bindingLayoutHash: options.layoutHash ?? 'layout:pbr-v1',
    selectedVariant: 'variant:base',
    availableMaterialFeatures: ['base-color']
  };
  const registry = new PreparedAssetRegistry();
  const meshKey = key('mesh:test', deviceGeneration, 'mesh-v1');
  const materialKey = key('material:test', deviceGeneration, 'material-v1');
  registry.publish({ key: meshKey, value: mesh });
  registry.publish({ key: materialKey, value: material });
  const meshLease = registry.acquire<PreparedMesh>(meshKey);
  const materialLease = registry.acquire<PreparedMaterialCompatibility>(materialKey);
  if (meshLease === undefined || materialLease === undefined)
    throw new Error('fixture lease missing');
  return {
    value: {
      entity: 1 as RenderEntityId,
      depthRange: [-2, -1],
      submesh: 0,
      mesh: meshLease,
      material: materialLease
    },
    dispose: () => {
      materialLease.dispose();
      meshLease.dispose();
    }
  };
}

function key(assetId: string, deviceGeneration: number, abiVersion: string): PreparedVariantKey {
  return {
    assetId,
    payloadVersion: 1,
    deviceGeneration,
    featurePolicyKey: 'policy:webgpu-baseline',
    abiVersion
  };
}

describe('material pipeline compatibility', () => {
  test('selects an exact technique and builds a complete immutable canonical key', () => {
    const fixture = candidate();
    const result = resolveMaterialPipelineCompatibility([fixture.value], context());
    expect(result.skipped).toEqual([]);
    expect(result.resolved[0]).toMatchObject({
      selection: { status: 'selected', technique: { name: 'exact' } },
      renderState: { status: 'resolved', cullMode: 'back', depthWrite: true },
      pipelineKey: {
        parts: {
          shaderModuleKey: 'shader:exact',
          bindingLayoutHash: 'layout:pbr-v1',
          attachmentFormats: ['rgba16float'],
          depthStencilFormat: 'depth24plus',
          sampleCount: 1,
          featurePolicyHash: 'policy:webgpu-baseline',
          deviceGeneration: 3
        }
      }
    });
    expect(Object.isFrozen(result.resolved[0]?.pipelineKey.parts)).toBe(true);
    fixture.dispose();
  });

  test('uses only an explicitly declared compatible fallback', () => {
    const fixture = candidate({
      techniques: [technique('fallback', forward, { fallbackFor: [gbuffer] })]
    });
    const result = resolveMaterialPipelineCompatibility([fixture.value], context());
    expect(result.resolved[0]?.selection).toMatchObject({
      status: 'fallback',
      technique: { name: 'fallback' },
      requestedRole: 'gbuffer',
      selectedRole: 'forward'
    });
    expect(result.skipped).toEqual([]);
    fixture.dispose();
  });

  test('returns typed skips for unsupported variants and incompatible layouts', () => {
    const unsupported = candidate({ techniques: [technique('forward-only', forward)] });
    const badLayout = candidate({ layoutHash: 'layout:other' });
    const result = resolveMaterialPipelineCompatibility(
      [unsupported.value, badLayout.value],
      context()
    );
    expect(result.resolved).toEqual([]);
    expect(result.skipped.map(({ code }) => code)).toEqual([
      'variant-unsupported',
      'layout-incompatible'
    ]);
    expect(result.skipped[0]?.diagnostic).toMatchObject({
      code: 'variant-unsupported',
      materialId: 'material:pipeline-test'
    });
    unsupported.dispose();
    badLayout.dispose();
  });

  test('rejects stale prepared generations without compiling or releasing leases', () => {
    const fixture = candidate({ deviceGeneration: 2 });
    const result = resolveMaterialPipelineCompatibility([fixture.value], context());
    expect(result.skipped[0]?.code).toBe('device-generation-stale');
    expect(fixture.value.mesh.disposed).toBe(false);
    expect(fixture.value.material.disposed).toBe(false);
    fixture.dispose();
  });

  test('changes canonical identity when mesh, policy, or device compatibility changes', () => {
    const base = candidate();
    const changedMesh = candidate({ streamSemantic: 'POSITION_HIGH' });
    const nextDevice = candidate({ deviceGeneration: 4 });
    const baseKey = resolveMaterialPipelineCompatibility([base.value], context()).resolved[0]
      ?.pipelineKey.canonicalValue;
    const meshKey = resolveMaterialPipelineCompatibility([changedMesh.value], context()).resolved[0]
      ?.pipelineKey.canonicalValue;
    const policyKey = resolveMaterialPipelineCompatibility(
      [base.value],
      context({ featurePolicyHash: 'policy:webgpu-hdr' })
    ).resolved[0]?.pipelineKey.canonicalValue;
    const deviceKey = resolveMaterialPipelineCompatibility(
      [nextDevice.value],
      context({ deviceGeneration: 4 })
    ).resolved[0]?.pipelineKey.canonicalValue;
    expect(new Set([baseKey, meshKey, policyKey, deviceKey])).toHaveProperty('size', 4);
    base.dispose();
    changedMesh.dispose();
    nextDevice.dispose();
  });

  test('canonicalizes vertex streams by typed buffer position instead of caller array order', () => {
    const position: PreparedMeshStreamLayout = {
      semantic: 'POSITION',
      format: 'float32x3',
      stride: 20,
      offset: 0,
      bufferSlot: 0
    };
    const uv: PreparedMeshStreamLayout = {
      semantic: 'TEXCOORD_0',
      format: 'float32x2',
      stride: 20,
      offset: 12,
      bufferSlot: 1
    };
    const ordered = candidate({ streams: [position, uv] });
    const reversed = candidate({ streams: [uv, position] });

    const orderedKey = resolveMaterialPipelineCompatibility([ordered.value], context()).resolved[0]
      ?.pipelineKey.canonicalValue;
    const reversedKey = resolveMaterialPipelineCompatibility([reversed.value], context())
      .resolved[0]?.pipelineKey.canonicalValue;

    expect(reversedKey).toBe(orderedKey);
    ordered.dispose();
    reversed.dispose();
  });

  test('keeps the compatibility skip code set closed at compile time', () => {
    const codes: readonly MaterialPipelineCompatibilitySkipCode[] = [
      'invalid-material-payload',
      'device-generation-stale',
      'layout-incompatible',
      'variant-unsupported',
      'render-state-conflict'
    ];
    expect(codes).toHaveLength(5);
  });
});

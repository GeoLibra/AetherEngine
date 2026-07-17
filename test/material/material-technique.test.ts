import { describe, expect, test } from 'vitest';
import {
  createMaterialAsset,
  createMaterialTechniqueRole,
  defineMaterialSchema,
  selectMaterialTechnique,
  type MaterialAssetDefinition,
  type MaterialTechnique,
  type MaterialTechniqueRequest,
  type MaterialTechniqueRole,
  type RenderPhaseKind
} from '../../src';

const forward = createMaterialTechniqueRole('forward');
const gbuffer = createMaterialTechniqueRole('gbuffer');
const compatibility = {
  semanticTag: 'lit-surface',
  bindingLayoutHash: 'layout-v1',
  requiredFeatures: ['texture-compression'],
  requiredMaterialFeatures: ['normal-map'],
  requiredViewFeatures: ['fog'],
  requiredMeshCapabilities: ['tangents'],
  attachmentFormats: ['rgba16float'],
  depthStencilFormats: ['depth24plus'],
  sampleCounts: [1]
} as const;

function technique(
  name: string,
  passRole: MaterialTechniqueRole,
  options: Partial<MaterialTechnique> = {}
): MaterialTechnique {
  return {
    name,
    passRole,
    shader: { moduleKey: `${name}-shader`, vertexEntry: 'vs', fragmentEntry: 'fs' },
    priority: 0,
    compatibility,
    ...options
  };
}

function request(options: Partial<MaterialTechniqueRequest> = {}): MaterialTechniqueRequest {
  return {
    phase: 'opaque',
    allowedRoles: [gbuffer, forward],
    availableFeatures: ['texture-compression'],
    availableMaterialFeatures: ['normal-map'],
    availableViewFeatures: ['fog'],
    availableMeshCapabilities: ['tangents'],
    bindingLayoutHash: 'layout-v1',
    attachmentFormats: ['rgba16float'],
    depthStencilFormat: 'depth24plus',
    sampleCount: 1,
    semanticTag: 'lit-surface',
    ...options
  };
}

function asset(techniques: readonly MaterialTechnique[]) {
  const schema = defineMaterialSchema({
    id: 'aether.material.technique-test',
    version: 1,
    fields: {}
  });
  return createMaterialAsset({
    id: 'material.technique-test',
    version: 1,
    schema,
    techniques,
    renderState: { surface: 'opaque' }
  });
}

describe('Material technique roles', () => {
  test('remain compile-time distinct from phases and raw strings', () => {
    const acceptsRole = (role: MaterialTechniqueRole) => role;
    const phase: RenderPhaseKind = 'opaque';

    expect(acceptsRole(forward)).toBe('forward');
    // @ts-expect-error Render phases and material technique roles are separate domains.
    acceptsRole(phase);
    // @ts-expect-error Raw strings must pass through the branded constructor.
    acceptsRole('forward');
  });

  test('require branded roles throughout MaterialAssetDefinition', () => {
    const schema = defineMaterialSchema({
      id: 'aether.material.typed-technique-definition',
      version: 1,
      fields: {}
    });
    const phase: RenderPhaseKind = 'opaque';
    const valid: MaterialAssetDefinition = {
      id: 'material.typed-technique-definition',
      version: 1,
      schema,
      techniques: [technique('valid', forward)],
      renderState: { surface: 'opaque' }
    };

    const rawRole: MaterialAssetDefinition = {
      ...valid,
      // @ts-expect-error Raw strings cannot enter a typed asset technique definition.
      techniques: [{ ...technique('raw', forward), passRole: 'forward' }]
    };
    const phaseRole: MaterialAssetDefinition = {
      ...valid,
      // @ts-expect-error Render phases cannot enter a typed asset technique definition.
      techniques: [{ ...technique('phase', forward), passRole: phase }]
    };

    expect(valid.techniques).toHaveLength(1);
    expect(rawRole.techniques).toHaveLength(1);
    expect(phaseRole.techniques).toHaveLength(1);
  });
});

describe('Material technique asset validation', () => {
  test.each([
    ['missing shader', { shader: undefined }],
    ['empty name', { name: '' }],
    ['non-finite priority', { priority: Number.NaN }],
    ['empty pass role', { passRole: '' }],
    ['missing feature array', { compatibility: { ...compatibility, requiredFeatures: undefined } }],
    ['invalid feature array', { compatibility: { ...compatibility, requiredFeatures: [1] } }],
    ['empty shader module', { shader: { moduleKey: '', vertexEntry: 'vs', fragmentEntry: 'fs' } }],
    ['invalid fallback role', { fallbackFor: [''] }]
  ])('rejects a malformed technique with %s before snapshotting', (_label, changed) => {
    const malformed = { ...technique('malformed', forward), ...changed };

    expect(() => asset([malformed as unknown as MaterialTechnique])).toThrow(
      /invalid material technique/i
    );
  });
});

describe('Material technique selection', () => {
  test('always prefers a compatible exact role over a higher-priority fallback', () => {
    const selected = selectMaterialTechnique(
      asset([
        technique('fallback', forward, { priority: 100, fallbackFor: [gbuffer] }),
        technique('exact', gbuffer, { priority: -10 })
      ]),
      request()
    );

    expect(selected).toMatchObject({
      status: 'selected',
      technique: { name: 'exact' },
      requestedRole: gbuffer,
      selectedRole: gbuffer,
      candidatesExamined: 1
    });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  test('uses explicit compatible fallbacks in allowed-role order', () => {
    const selected = selectMaterialTechnique(
      asset([
        technique('forward-z', forward, { priority: 5, fallbackFor: [gbuffer] }),
        technique('exact-incompatible', gbuffer, {
          priority: 99,
          compatibility: { ...compatibility, requiredViewFeatures: ['ssao'] }
        }),
        technique('forward-a', forward, { priority: 5, fallbackFor: [gbuffer] })
      ]),
      request()
    );

    expect(selected).toMatchObject({
      status: 'fallback',
      technique: { name: 'forward-a' },
      requestedRole: gbuffer,
      selectedRole: forward,
      fallbackReason: 'No compatible exact gbuffer technique; using declared forward fallback.',
      candidatesExamined: 2
    });
  });

  test.each([
    ['feature', { availableFeatures: [] }],
    ['material feature', { availableMaterialFeatures: [] }],
    ['view feature', { availableViewFeatures: [] }],
    ['mesh capability', { availableMeshCapabilities: [] }],
    ['semantic tag', { semanticTag: 'unlit' }],
    ['binding layout', { bindingLayoutHash: 'layout-v2' }],
    ['attachments', { attachmentFormats: ['rgba8unorm'] }],
    ['depth format', { depthStencilFormat: 'depth32float' }],
    ['sample count', { sampleCount: 4 }]
  ])('requires exact compatibility for the %s axis', (_label, changed) => {
    const selected = selectMaterialTechnique(
      asset([technique('exact', gbuffer)]),
      request(changed)
    );

    expect(selected).toMatchObject({
      status: 'unsupported',
      candidatesExamined: 1,
      diagnostic: { code: 'no-compatible-technique' }
    });
  });

  test('does not infer an undeclared or semantic-changing fallback', () => {
    const selected = selectMaterialTechnique(
      asset([
        technique('undeclared', forward),
        technique('wrong-semantic', forward, {
          fallbackFor: [gbuffer],
          compatibility: { ...compatibility, semanticTag: 'unlit-surface' }
        })
      ]),
      request()
    );

    expect(selected).toMatchObject({
      status: 'unsupported',
      candidatesExamined: 1,
      diagnostic: {
        code: 'no-compatible-technique',
        reasons: expect.arrayContaining(['No compatible exact gbuffer technique.'])
      }
    });
  });

  test('is capability-driven and has no backend-name decision axis', () => {
    const material = asset([technique('exact', gbuffer)]);
    const webgpuNamed = selectMaterialTechnique(
      material,
      request({ availableFeatures: ['texture-compression', 'backend:webgpu'] })
    );
    const webglNamed = selectMaterialTechnique(
      material,
      request({ availableFeatures: ['texture-compression', 'backend:webgl2'] })
    );

    expect(webgpuNamed).toMatchObject({ status: 'selected', technique: { name: 'exact' } });
    expect(webglNamed).toMatchObject({ status: 'selected', technique: { name: 'exact' } });
  });
});

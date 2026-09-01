import { describe, expect, test } from 'vitest';
import {
  defineShaderAuthoringSource,
  validateWgslShaderMetadata
} from '../../src/shader/authoring';
import { decodeCookedShaderRuntimeArtifact } from '../../src/shader/artifact';
import type { CookedShaderRuntimeArtifact, WgslShaderMetadata } from '../../src/shader/types';

describe('ShaderAuthoringSource contracts', () => {
  test('creates default WGSL authoring source with canonical URI', () => {
    const source = defineShaderAuthoringSource({ uri: 'asset://shaders/lit.wgsl' });
    expect(source).toEqual({
      kind: 'wgsl',
      uri: 'asset://shaders/lit.wgsl',
      languageVersion: 'wgsl-1'
    });
    expect(Object.isFrozen(source)).toBe(true);
  });

  test('accepts package:// scheme and explicit source kinds', () => {
    const source = defineShaderAuthoringSource({
      kind: 'flux-experimental',
      uri: 'package://engine/standard-lit.flux'
    });
    expect(source).toEqual({
      kind: 'flux-experimental',
      uri: 'package://engine/standard-lit.flux',
      languageVersion: 'flux-1'
    });
  });

  test('rejects local file paths or invalid URIs without canonical scheme', () => {
    expect(() => defineShaderAuthoringSource({ uri: '/Users/test/shader.wgsl' })).toThrow(
      /canonical URI/i
    );
    expect(() => defineShaderAuthoringSource({ uri: 'file:///shaders/lit.wgsl' })).toThrow(
      /canonical URI/i
    );
    expect(() => defineShaderAuthoringSource({ uri: '' })).toThrow(/canonical URI/i);
  });

  test('rejects invalid or unsupported source kinds', () => {
    expect(() =>
      defineShaderAuthoringSource({
        // @ts-expect-error test invalid source kind
        kind: 'glsl',
        uri: 'asset://shaders/lit.glsl'
      })
    ).toThrow(/unsupported shader source kind/i);
  });
});

describe('WgslShaderMetadata validation', () => {
  const validMetadata: WgslShaderMetadata = {
    schemaVersion: 1,
    entryPoints: [
      { name: 'vertexMain', stage: 'vertex' },
      { name: 'fragmentMain', stage: 'fragment' }
    ],
    imports: [{ path: 'asset://shaders/common.wgsl', alias: 'common' }],
    variants: [{ name: 'HAS_SHADOW', values: ['0', '1'], defaultValue: '0' }],
    capabilityRequirements: [{ feature: 'depth-clip-control' }],
    materialBindings: [{ binding: 'colorMap', property: 'albedoTexture' }],
    cookPolicy: { optimization: 'performance', preserveNames: false }
  };

  test('validates and defensively copies valid metadata', () => {
    const validated = validateWgslShaderMetadata(validMetadata);
    expect(validated).toEqual(validMetadata);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.entryPoints)).toBe(true);
    expect(Object.isFrozen(validated.entryPoints[0])).toBe(true);
  });

  test('rejects unknown metadata keys', () => {
    const withUnknown = { ...validMetadata, extraField: 'invalid' };
    expect(() => validateWgslShaderMetadata(withUnknown)).toThrow(/unknown metadata field/i);
  });

  test('rejects invalid schema version', () => {
    expect(() => validateWgslShaderMetadata({ ...validMetadata, schemaVersion: 2 as 1 })).toThrow(
      /unsupported schemaVersion/i
    );
  });

  test('rejects duplicate entry point names', () => {
    const duplicate = {
      ...validMetadata,
      entryPoints: [
        { name: 'main', stage: 'vertex' as const },
        { name: 'main', stage: 'fragment' as const }
      ]
    };
    expect(() => validateWgslShaderMetadata(duplicate)).toThrow(/duplicate entry point/i);
  });

  test('rejects invalid entry point stage', () => {
    const invalidStage = {
      ...validMetadata,
      entryPoints: [{ name: 'main', stage: 'geometry' as 'vertex' }]
    };
    expect(() => validateWgslShaderMetadata(invalidStage)).toThrow(/invalid stage/i);
  });
});

describe('decodeCookedShaderRuntimeArtifact validation', () => {
  const validBinding = {
    group: 0,
    binding: 0,
    name: 'scene',
    kind: 'uniform-buffer' as const,
    addressSpace: 'uniform' as const,
    access: 'read' as const,
    typeName: 'SceneUniforms'
  };

  const validArtifact: CookedShaderRuntimeArtifact = {
    schemaVersion: 1,
    shaderManifestSchemaVersion: 1,
    shaderModuleSchemaVersion: 1,
    sourceKind: 'wgsl',
    toolchain: {
      cookerId: 'aether-native-wgsl-cooker',
      cookerVersion: '0.0.0',
      nagaVersion: '30.0.0'
    },
    source: {
      sourceUri: 'asset://shaders/lit.wgsl',
      contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      byteLength: 256
    },
    entryPoints: [
      {
        name: 'vertexMain',
        stage: 'vertex',
        bindings: [validBinding]
      },
      {
        name: 'fragmentMain',
        stage: 'fragment',
        bindings: []
      }
    ],
    bindings: [validBinding],
    modules: {
      wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}',
      glslEs300: {
        'vertex:vertexMain': '#version 300 es\nvoid main() {}',
        'fragment:fragmentMain': '#version 300 es\nvoid main() {}'
      }
    }
  };

  test('decodes and validates a compliant cooked runtime artifact', () => {
    const decoded = decodeCookedShaderRuntimeArtifact(validArtifact);
    expect(decoded).toEqual(validArtifact);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.entryPoints)).toBe(true);
    expect(Object.isFrozen(decoded.modules)).toBe(true);
  });

  test('rejects missing or empty toolchain info', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        toolchain: { ...validArtifact.toolchain, nagaVersion: '' }
      })
    ).toThrow(/nagaVersion/i);
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        toolchain: { ...validArtifact.toolchain, cookerId: '' }
      })
    ).toThrow(/cookerId/i);
  });

  test('rejects missing GLSL ES 300 module for graphics entry points', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        modules: {
          wgsl: validArtifact.modules.wgsl,
          glslEs300: {
            'vertex:vertexMain': '#version 300 es\nvoid main() {}'
            // missing fragment:fragmentMain
          }
        }
      })
    ).toThrow(/missing glsl/i);
  });

  test('rejects duplicate bindings in the same entry point', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        entryPoints: [
          {
            name: 'vertexMain',
            stage: 'vertex',
            bindings: [validBinding, validBinding]
          }
        ]
      })
    ).toThrow(/duplicate binding/i);
  });

  test('rejects non-canonical source URI', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        source: {
          ...validArtifact.source,
          sourceUri: '/local/path/to/shader.wgsl'
        }
      })
    ).toThrow(/canonical URI/i);
  });
});

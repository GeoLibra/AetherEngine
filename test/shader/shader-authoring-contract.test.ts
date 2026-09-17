import { describe, expect, test } from 'vitest';
import {
  assertValidCanonicalShaderSourceUri,
  defineShaderAuthoringSource,
  isValidCanonicalShaderSourceUri,
  validateWgslShaderMetadata
} from '../../src/shader/authoring';
import { decodeCookedShaderRuntimeArtifact } from '../../src/shader/artifact';
import type { CookedShaderRuntimeArtifact, WgslShaderMetadata } from '../../src/shader/types';

describe('ShaderAuthoringSource contracts and URI validation', () => {
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

  test('rejects relative traversal, query, fragment, backslash, percent-encoding, or empty segments in canonical URIs', () => {
    expect(isValidCanonicalShaderSourceUri('asset://shaders/common.wgsl')).toBe(true);
    expect(isValidCanonicalShaderSourceUri('package://engine/standard-lit.wgsl')).toBe(true);

    // Forbidden variants
    expect(isValidCanonicalShaderSourceUri('asset://a/../b.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a/./b.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a//b.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a/b.wgsl?version=1')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a/b.wgsl#section')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a\\b.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('asset://a%20b.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('http://example.com/shader.wgsl')).toBe(false);
    expect(isValidCanonicalShaderSourceUri('/local/path.wgsl')).toBe(false);

    expect(() => assertValidCanonicalShaderSourceUri('asset://a/../b.wgsl')).toThrow(
      /canonical URI/i
    );
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
    expect(Object.isFrozen(validated.entryPoints?.[0])).toBe(true);
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

  test('rejects root shader metadata missing entryPoints or with empty entryPoints', () => {
    const withoutEntryPoints = { schemaVersion: 1 };
    expect(() => validateWgslShaderMetadata(withoutEntryPoints)).toThrow(
      /Executable WGSL root shader metadata must declare entryPoints/i
    );

    const emptyEntryPoints = { schemaVersion: 1, entryPoints: [] };
    expect(() => validateWgslShaderMetadata(emptyEntryPoints)).toThrow(
      /entryPoints must be a non-empty array/i
    );
  });

  test('validates module metadata without requiring entryPoints', () => {
    const moduleMeta = {
      schemaVersion: 1,
      imports: [{ path: 'asset://common/math.wgsl' }]
    };
    const validated = validateWgslShaderMetadata(moduleMeta, { kind: 'module' });
    expect(validated.entryPoints).toBeUndefined();
    expect(validated.imports).toHaveLength(1);
    expect(Object.isFrozen(validated)).toBe(true);
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

  test('rejects non-string or duplicate variant values and out-of-set defaultValue', () => {
    // Non-string variant value (e.g. number)
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        variants: [{ name: 'HAS_SHADOW', values: [0, 1] }]
      })
    ).toThrow(/non-empty string/i);

    // Duplicate variant values
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        variants: [{ name: 'HAS_SHADOW', values: ['1', '1'] }]
      })
    ).toThrow(/duplicate value/i);

    // Duplicate variant dimension names
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        variants: [
          { name: 'HAS_SHADOW', values: ['0', '1'] },
          { name: 'HAS_SHADOW', values: ['0', '1'] }
        ]
      })
    ).toThrow(/duplicate variant dimension/i);

    // defaultValue not in values
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        variants: [{ name: 'HAS_SHADOW', values: ['0', '1'], defaultValue: '2' }]
      })
    ).toThrow(/default value.*must be one of/i);

    // Non-string defaultValue
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        variants: [{ name: 'HAS_SHADOW', values: ['0', '1'], defaultValue: 0 }]
      })
    ).toThrow(/non-empty string/i);
  });

  test('rejects invalid cookPolicy options', () => {
    // Invalid optimization value
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        cookPolicy: { optimization: 'ultra' }
      })
    ).toThrow(/invalid optimization/i);

    // Non-boolean preserveNames
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        cookPolicy: { preserveNames: 'yes' }
      })
    ).toThrow(/invalid preserveNames/i);

    // Unknown cookPolicy field
    expect(() =>
      validateWgslShaderMetadata({
        ...validMetadata,
        cookPolicy: { extraOption: true }
      })
    ).toThrow(/unknown cookPolicy field/i);
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
    schemaVersion: 2,
    shaderManifestSchemaVersion: 1,
    shaderModuleSchemaVersion: 2,
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
    bufferLayouts: [
      {
        group: 0,
        binding: 0,
        name: 'scene',
        byteSize: 80,
        alignment: 16,
        fields: [
          {
            path: 'viewProjection',
            offset: 0,
            size: 64,
            alignment: 16,
            typeName: 'mat4x4<f32>'
          }
        ]
      }
    ],
    vertexInputs: [
      { location: 0, name: 'position', typeName: 'vec3<f32>' },
      { location: 1, name: 'normal', typeName: 'vec3<f32>' }
    ],
    fragmentOutputs: [{ location: 0, name: 'fragmentMain', typeName: 'vec4<f32>' }],
    modules: {
      wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}',
      glslEs300: {
        'vertex:vertexMain': {
          source: '#version 300 es\nvoid main() {}',
          bindings: [
            {
              kind: 'uniform-buffer',
              name: 'SceneUniforms_block_0Vertex',
              resource: { group: 0, binding: 0 }
            }
          ]
        },
        'fragment:fragmentMain': {
          source: '#version 300 es\nvoid main() {}',
          bindings: []
        }
      }
    }
  };

  test('decodes frozen GLSL program bindings from schema version 2 module records', () => {
    const decoded = decodeCookedShaderRuntimeArtifact({
      ...validArtifact,
      schemaVersion: 2,
      shaderModuleSchemaVersion: 2,
      modules: {
        wgsl: validArtifact.modules.wgsl,
        glslEs300: {
          'vertex:vertexMain': {
            source: '#version 300 es\nvoid main() {}',
            bindings: [
              {
                kind: 'uniform-buffer',
                name: 'SceneUniforms_block_0Vertex',
                resource: { group: 0, binding: 0 }
              }
            ]
          },
          'fragment:fragmentMain': {
            source: '#version 300 es\nvoid main() {}',
            bindings: []
          }
        }
      }
    });

    const vertexModule = decoded.modules.glslEs300['vertex:vertexMain'];
    expect(vertexModule?.bindings).toEqual([
      {
        kind: 'uniform-buffer',
        name: 'SceneUniforms_block_0Vertex',
        resource: { group: 0, binding: 0 }
      }
    ]);
    expect(Object.isFrozen(vertexModule)).toBe(true);
    expect(Object.isFrozen(vertexModule?.bindings[0])).toBe(true);
  });

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

  test('rejects missing GLSL ES 300 module for graphics entry points on portable artifacts', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        modules: {
          wgsl: validArtifact.modules.wgsl,
          glslEs300: {
            'vertex:vertexMain': validArtifact.modules.glslEs300['vertex:vertexMain']
            // missing fragment:fragmentMain
          }
        }
      })
    ).toThrow(/missing glsl/i);
  });

  test('permits omitting GLSL ES 300 modules when targetBackend is webgpu', () => {
    const webgpuArtifact = decodeCookedShaderRuntimeArtifact({
      ...validArtifact,
      targetBackend: 'webgpu',
      modules: {
        wgsl: validArtifact.modules.wgsl,
        glslEs300: {}
      }
    });
    expect(webgpuArtifact.targetBackend).toBe('webgpu');
    expect(webgpuArtifact.modules.glslEs300).toEqual({});
  });

  test('rejects invalid targetBackend values', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        targetBackend: 'invalid-backend' as unknown as 'webgpu'
      })
    ).toThrow(/invalid targetbackend/i);
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

  test('rejects entry point binding not declared in global bindings', () => {
    const undeclaredBinding = { ...validBinding, binding: 1 };
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        entryPoints: [
          {
            name: 'vertexMain',
            stage: 'vertex',
            bindings: [undeclaredBinding]
          }
        ]
      })
    ).toThrow(/not declared in global bindings/i);
  });

  test('rejects entry point binding that does not match global binding definition', () => {
    const mismatchedBinding = { ...validBinding, name: 'otherName' };
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        entryPoints: [
          {
            name: 'vertexMain',
            stage: 'vertex',
            bindings: [mismatchedBinding]
          }
        ]
      })
    ).toThrow(/does not match/i);
  });

  test('rejects duplicate global bindings', () => {
    const duplicateSlot = { ...validBinding, name: 'otherScene' };
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        bindings: [validBinding, duplicateSlot]
      })
    ).toThrow(/duplicate global binding/i);
  });

  test('rejects non-64-character hex content hash', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        source: {
          ...validArtifact.source,
          contentHash: 'invalid-hash'
        }
      })
    ).toThrow(/64-character/i);
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

  test('rejects unexpected GLSL module keys not matching declared entry points', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        modules: {
          ...validArtifact.modules,
          glslEs300: {
            ...validArtifact.modules.glslEs300,
            'vertex:unknownEntry': {
              source: '#version 300 es\nvoid main() {}',
              bindings: []
            }
          }
        }
      })
    ).toThrow(/unexpected glsl/i);
  });

  test('rejects entry point with missing or non-array bindings', () => {
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        entryPoints: [
          {
            name: 'vertexMain',
            stage: 'vertex',
            bindings: undefined
          }
        ]
      })
    ).toThrow(/bindings must be an array/i);

    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        entryPoints: [
          {
            name: 'vertexMain',
            stage: 'vertex',
            bindings: {}
          }
        ]
      })
    ).toThrow(/bindings must be an array/i);
  });

  test('rejects bindings with missing addressSpace, access, or typeName', () => {
    // Missing addressSpace
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        bindings: [
          {
            ...validBinding,
            addressSpace: undefined
          }
        ]
      })
    ).toThrow(/addressSpace must be a non-empty string/i);

    // Missing access
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        bindings: [
          {
            ...validBinding,
            access: ''
          }
        ]
      })
    ).toThrow(/access must be a non-empty string/i);

    // Missing typeName
    expect(() =>
      decodeCookedShaderRuntimeArtifact({
        ...validArtifact,
        bindings: [
          {
            ...validBinding,
            typeName: undefined
          }
        ]
      })
    ).toThrow(/typeName must be a non-empty string/i);
  });

  test('rejects missing cooked buffer layout reflection', () => {
    const { bufferLayouts: _, ...missingLayouts } = validArtifact;
    expect(() => decodeCookedShaderRuntimeArtifact(missingLayouts)).toThrow(
      /bufferLayouts must be an array/i
    );
  });

  test('accepts combined-sampler GLSL program bindings with null or omitted sampler', () => {
    const textureBinding = {
      group: 0,
      binding: 1,
      name: 'uTexture',
      kind: 'texture' as const,
      addressSpace: 'handle' as const,
      access: 'read' as const,
      typeName: 'texture_2d<f32>'
    };
    const artifactWithCombinedSamplers = {
      ...validArtifact,
      bindings: [validBinding, textureBinding],
      entryPoints: [
        {
          name: 'vertexMain',
          stage: 'vertex' as const,
          bindings: [validBinding]
        },
        {
          name: 'fragmentMain',
          stage: 'fragment' as const,
          bindings: [textureBinding]
        }
      ],
      modules: {
        wgsl: validArtifact.modules.wgsl,
        glslEs300: {
          'vertex:vertexMain': validArtifact.modules.glslEs300['vertex:vertexMain'],
          'fragment:fragmentMain': {
            source: '#version 300 es\nvoid main() {}',
            bindings: [
              {
                kind: 'combined-sampler',
                name: 'uTexture_sampler_null',
                texture: { group: 0, binding: 1 },
                sampler: null
              }
            ]
          }
        }
      }
    };

    const decoded = decodeCookedShaderRuntimeArtifact(artifactWithCombinedSamplers);
    const fragmentBindings = decoded.modules.glslEs300['fragment:fragmentMain']?.bindings;
    expect(fragmentBindings).toBeDefined();
    expect(fragmentBindings![0]).toEqual({
      kind: 'combined-sampler',
      name: 'uTexture_sampler_null',
      texture: { group: 0, binding: 1 }
    });
  });
});

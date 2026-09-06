import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  LIGHT_LIST_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_MODULE,
  LIGHT_LIST_WEBGL_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL_SHADER_MODULE,
  POST_COLOR_SHADER_ARTIFACT,
  POST_COLOR_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL_SHADER_MODULE,
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_MODULE,
  createCookedArtifactWebGL2Translator,
  createWebGL2TranslationRouter
} from '../../src';

describe('Built-in WebGL2 Shader Translation Router & Generic Translator', () => {
  test('routes each built-in shader module to its subsystem translator', () => {
    // 1. Standard-Lit
    const standardLitVertex = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_SHADER_MODULE,
      stage: 'vertex',
      entryPoint: 'standardLitVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(standardLitVertex.source).not.toMatch(/^#version/m);
    expect(standardLitVertex.targetAbiFingerprint).toBe('standard-lit-v2');

    // 2. Post-Color
    const postColorFrag = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: POST_COLOR_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'postColorFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(postColorFrag.source).not.toMatch(/^#version/m);
    expect(postColorFrag.targetAbiFingerprint).toBe('post-color-v1');

    // 3. Light-List WebGL2 MRT
    const lightListFrag = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: LIGHT_LIST_WEBGL2_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'lightListFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(lightListFrag.source).not.toMatch(/^#version/m);
    expect(lightListFrag.targetAbiFingerprint).toBe('light-list-webgl-v2');

    // 4. Standard-Lit LightList WebGL2
    const standardLitListFrag = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'standardLitFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(standardLitListFrag.source).not.toMatch(/^#version/m);
    expect(standardLitListFrag.targetAbiFingerprint).toBe('standard-lit-list-v1');
  });

  test('fails fast when an unregistered shader module is passed', () => {
    expect(() =>
      BUILT_IN_WEBGL2_TRANSLATOR.translate({
        wgsl: '/* unknown custom wgsl code */ @fragment fn foo() {}',
        stage: 'fragment',
        entryPoint: 'foo',
        constants: {},
        capabilities: [],
        approvedExtensions: [],
        clipDepthMode: 'vertex-remap'
      })
    ).toThrowError(/Unrecognized shader module passed to WebGL2 translation router/);
  });

  test('createWebGL2TranslationRouter rejects duplicate module registrations', () => {
    expect(() =>
      createWebGL2TranslationRouter([
        {
          module: STANDARD_LIT_SHADER_MODULE,
          translator: {
            translatorId: 'test-1',
            version: 1,
            translate: () => ({}) as never
          }
        },
        {
          module: STANDARD_LIT_SHADER_MODULE,
          translator: {
            translatorId: 'test-2',
            version: 1,
            translate: () => ({}) as never
          }
        }
      ])
    ).toThrowError(/Duplicate shader module registered/);
  });

  test('createCookedArtifactWebGL2Translator validates entry points and missing modules', () => {
    const translator = createCookedArtifactWebGL2Translator({
      translatorId: 'test.translator',
      version: 1,
      artifact: POST_COLOR_SHADER_ARTIFACT,
      supportedEntryPoints: ['postColorVertex']
    });

    // Valid entry point
    const vertex = translator.translate({
      wgsl: POST_COLOR_SHADER_MODULE,
      stage: 'vertex',
      entryPoint: 'postColorVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(vertex.source).toBeTruthy();

    // Denied by supportedEntryPoints whitelist
    expect(() =>
      translator.translate({
        wgsl: POST_COLOR_SHADER_MODULE,
        stage: 'fragment',
        entryPoint: 'postColorFragment',
        constants: {},
        capabilities: [],
        approvedExtensions: [],
        clipDepthMode: 'vertex-remap'
      })
    ).toThrowError(/Unsupported entry point "postColorFragment"/);

    // Missing from artifact
    expect(() =>
      translator.translate({
        wgsl: POST_COLOR_SHADER_MODULE,
        stage: 'vertex',
        entryPoint: 'nonExistent',
        constants: {},
        capabilities: [],
        approvedExtensions: [],
        clipDepthMode: 'vertex-remap'
      })
    ).toThrowError(/Unsupported entry point "nonExistent"/);
  });

  test('createCookedArtifactWebGL2Translator supports custom physical binding mappings', () => {
    const translator = createCookedArtifactWebGL2Translator({
      translatorId: 'test.custom-map',
      version: 1,
      artifact: POST_COLOR_SHADER_ARTIFACT,
      mapPhysicalBindings: (bindings) =>
        bindings.map((b) => ({
          ...b,
          slot: 99
        }))
    });

    const result = translator.translate({
      wgsl: POST_COLOR_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'postColorFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });

    expect(result.physicalBindings.every((b) => b.slot === 99)).toBe(true);
  });

  test('maintains identical identity between WebGL2 canonical symbols and legacy WebGL aliases', () => {
    expect(LIGHT_LIST_WEBGL_SHADER_ARTIFACT).toBe(LIGHT_LIST_WEBGL2_SHADER_ARTIFACT);
    expect(LIGHT_LIST_WEBGL_SHADER_MODULE).toBe(LIGHT_LIST_WEBGL2_SHADER_MODULE);
    expect(STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT).toBe(STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT);
    expect(STANDARD_LIT_LIST_WEBGL_SHADER_MODULE).toBe(STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE);
  });
});

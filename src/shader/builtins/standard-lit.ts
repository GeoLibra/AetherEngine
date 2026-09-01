import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { remapVertexClipDepth } from '../../rhi/webgl2/pipeline/clip-depth';
import { emitGlslEsModule } from '../backends/glsl';
import type { ShaderSourceRef, ShaderSourceResolver } from '../types';
import {
  STANDARD_LIT_SHADER_GENERATED_MODULE,
  STANDARD_LIT_SHADER_SOURCE_TEXT
} from './standard-lit.generated';

export const STANDARD_LIT_SHADER_ABI_VERSION = 2;

/** Authored FluxSL source identity used by cook tools and source-mapped diagnostics. */
export const STANDARD_LIT_SHADER_SOURCE: ShaderSourceRef = Object.freeze({
  uri: 'asset://aether/builtins/standard-lit.flux',
  languageVersion: 1
});

/** Creates the resolver used by tooling to recook the authored standard-lit source. */
export function createStandardLitShaderResolver(
  fallback?: ShaderSourceResolver
): ShaderSourceResolver {
  return Object.freeze({
    async load(uri: string): Promise<string> {
      if (uri === STANDARD_LIT_SHADER_SOURCE.uri) return STANDARD_LIT_SHADER_SOURCE_TEXT;
      if (fallback) return fallback.load(uri);
      throw new Error(`Shader source not found: ${uri}`);
    }
  });
}

const STANDARD_LIT_WEBGL2_BINDINGS = Object.freeze(
  ['objectData', 'viewData', 'materialData', 'lightData'].map((name, group) =>
    Object.freeze({ group, binding: 0, name, kind: 'uniform-buffer' as const })
  )
);

/** Built-in typed-shader lowering used by the browser baseline WebGL2 path. */
export const STANDARD_LIT_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort = Object.freeze({
  translatorId: 'aether.standard-lit.typed-glsl',
  version: STANDARD_LIT_SHADER_ABI_VERSION,
  translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
    if (input.entryPoint !== 'standardLitVertex' && input.entryPoint !== 'standardLitFragment') {
      throw new Error(`Unsupported standard-lit entry point "${input.entryPoint}".`);
    }
    const emitted = emitGlslEsModule(STANDARD_LIT_SHADER_MODULE, input.entryPoint);
    const source =
      input.stage === 'vertex' && input.clipDepthMode === 'vertex-remap'
        ? remapVertexClipDepth(emitted)
        : emitted;
    return Object.freeze({
      source,
      bindings: STANDARD_LIT_WEBGL2_BINDINGS,
      targetAbiFingerprint: `standard-lit-v${STANDARD_LIT_SHADER_ABI_VERSION}`,
      physicalBindings: Object.freeze(
        STANDARD_LIT_WEBGL2_BINDINGS.map((binding) =>
          Object.freeze({ ...binding, slot: binding.group })
        )
      ),
      programBindings: Object.freeze(
        STANDARD_LIT_WEBGL2_BINDINGS.map((binding) =>
          Object.freeze({
            kind: 'uniform-buffer' as const,
            name: `Aether_${binding.group}_${binding.binding}`,
            slot: binding.group
          })
        )
      ),
      requiredExtensions: EMPTY_REQUIRED_EXTENSIONS,
      sourceMap: EMPTY_TRANSLATED_SOURCE_MAP,
      translatorFingerprint: `${input.entryPoint}:v${STANDARD_LIT_SHADER_ABI_VERSION}`
    });
  }
});

const EMPTY_REQUIRED_EXTENSIONS: readonly string[] = Object.freeze([]);
const EMPTY_TRANSLATED_SOURCE_MAP: readonly Readonly<{
  generatedLine: number;
  authoredLine: number;
}>[] = Object.freeze([]);

/** Versioned cooked shader module for the baseline standard-lit material. */
export const STANDARD_LIT_SHADER_MODULE = STANDARD_LIT_SHADER_GENERATED_MODULE;

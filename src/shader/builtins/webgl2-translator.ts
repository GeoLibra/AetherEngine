import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { LIGHT_LIST_WEBGL2_SHADER_MODULE, LIGHT_LIST_WEBGL2_TRANSLATOR } from './light-list';
import { POST_COLOR_SHADER_MODULE, POST_COLOR_WEBGL2_TRANSLATOR } from './post-color';
import {
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL2_TRANSLATOR
} from './standard-lit-list';
import { STANDARD_LIT_SHADER_MODULE, STANDARD_LIT_WEBGL2_TRANSLATOR } from './standard-lit';

export interface WebGL2ShaderModuleRegistration {
  readonly module: string;
  readonly translator: WebGL2ShaderTranslationPort;
}

export interface WebGL2TranslationRouterOptions {
  readonly routerId?: string;
  readonly version?: number;
}

/**
 * Creates a deterministic, fail-fast WebGL2 translation router backed by explicit module identities.
 *
 * @throws When an unknown or unregistered shader module is passed to translate().
 */
export function createWebGL2TranslationRouter(
  registrations: readonly WebGL2ShaderModuleRegistration[],
  options: WebGL2TranslationRouterOptions = {}
): WebGL2ShaderTranslationPort {
  const routerId = options.routerId ?? 'aether.builtins.naga-glsl';
  const version = options.version ?? 1;
  const registry = new Map<string, WebGL2ShaderTranslationPort>();

  for (const reg of registrations) {
    if (registry.has(reg.module)) {
      throw new Error(
        `Duplicate shader module registered in WebGL2 translation router "${routerId}".`
      );
    }
    registry.set(reg.module, reg.translator);
  }

  return Object.freeze({
    translatorId: routerId,
    version,
    translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
      const translator = registry.get(input.wgsl);
      if (!translator) {
        throw new Error(
          `Unrecognized shader module passed to WebGL2 translation router "${routerId}" for entry point "${input.entryPoint}" (stage: "${input.stage}"). Registered modules: ${registry.size}. Ensure the shader module is registered.`
        );
      }
      return translator.translate(input);
    }
  });
}

/** Built-in browser translator routing each recognized cooked module to its owning subsystem translator. */
export const BUILT_IN_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort =
  createWebGL2TranslationRouter([
    {
      module: STANDARD_LIT_SHADER_MODULE,
      translator: STANDARD_LIT_WEBGL2_TRANSLATOR
    },
    {
      module: POST_COLOR_SHADER_MODULE,
      translator: POST_COLOR_WEBGL2_TRANSLATOR
    },
    {
      module: LIGHT_LIST_WEBGL2_SHADER_MODULE,
      translator: LIGHT_LIST_WEBGL2_TRANSLATOR
    },
    {
      module: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
      translator: STANDARD_LIT_LIST_WEBGL2_TRANSLATOR
    }
  ]);

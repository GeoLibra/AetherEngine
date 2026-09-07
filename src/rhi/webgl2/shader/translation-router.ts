/**
 * @file Deterministic, fail-fast WebGL2 shader translation router.
 * Routes incoming WGSL shader modules to their respective pre-cooked or customized translator adapters.
 */

import type {
  WebGL2BindingManifestEntry,
  WebGL2PhysicalBinding,
  WebGL2ProgramBinding,
  WebGL2ShaderTranslationPort
} from '../types';
import {
  createCookedArtifactWebGL2Translator,
  type CookedArtifactWebGL2TranslatorOptions,
  type WebGL2TranslationInput
} from './cooked-artifact-translator';
import type { CookedGlslEs300Module, CookedShaderRuntimeArtifact } from '../../../shader/types';

/**
 * Custom override options for a specific WebGL2 shader registration.
 */
export interface WebGL2ShaderRegistrationOverrides {
  readonly translatorId?: string;
  readonly version?: number;
  readonly targetAbiFingerprint?: string | ((input: WebGL2TranslationInput) => string);
  readonly mapPhysicalBindings?: (
    activeBindings: readonly WebGL2BindingManifestEntry[],
    emittedModule: CookedGlslEs300Module,
    input: WebGL2TranslationInput
  ) => readonly WebGL2PhysicalBinding[];
  readonly mapProgramBindings?: (
    emittedModule: CookedGlslEs300Module,
    input: WebGL2TranslationInput
  ) => readonly WebGL2ProgramBinding[];
  readonly requiredExtensions?:
    readonly string[] | ((input: WebGL2TranslationInput) => readonly string[]);
  readonly supportedEntryPoints?: readonly string[];
}

/**
 * Declarative registration of a cooked artifact with optional WebGL2 overrides.
 */
export interface WebGL2ShaderRegistration {
  readonly artifact: CookedShaderRuntimeArtifact;
  readonly webgl2?: WebGL2ShaderRegistrationOverrides;
}

/**
 * Backward compatibility alias for BuiltInShaderRegistration.
 */
export type BuiltInShaderRegistration = WebGL2ShaderRegistration;

/**
 * Explicit module-to-translator registration.
 */
export interface WebGL2ShaderModuleRegistration {
  readonly module: string;
  readonly translator: WebGL2ShaderTranslationPort;
}

/**
 * Accepted registration entry types in createWebGL2TranslationRouter.
 */
export type WebGL2RouterRegistrationEntry =
  | WebGL2ShaderRegistration
  | CookedShaderRuntimeArtifact
  | CookedArtifactWebGL2TranslatorOptions
  | WebGL2ShaderModuleRegistration;

/**
 * Options for createWebGL2TranslationRouter.
 */
export interface WebGL2TranslationRouterOptions {
  readonly routerId?: string;
  readonly version?: number;
}

function resolveRegistration(entry: WebGL2RouterRegistrationEntry): WebGL2ShaderModuleRegistration {
  if ('module' in entry && 'translator' in entry) {
    return entry;
  }
  if ('artifact' in entry) {
    if ('webgl2' in entry && entry.webgl2) {
      return {
        module: entry.artifact.modules.wgsl,
        translator: createCookedArtifactWebGL2Translator({
          artifact: entry.artifact,
          ...entry.webgl2
        })
      };
    }
    return {
      module: entry.artifact.modules.wgsl,
      translator: createCookedArtifactWebGL2Translator(
        entry as CookedArtifactWebGL2TranslatorOptions
      )
    };
  }
  return {
    module: entry.modules.wgsl,
    translator: createCookedArtifactWebGL2Translator(entry)
  };
}

export type { WebGL2ShaderTranslationPort };

/**
 * Creates a deterministic, fail-fast WebGL2 translation router backed by explicit module identities.
 * Accepts declarative WebGL2ShaderRegistration entries, direct CookedShaderRuntimeArtifacts,
 * CookedArtifactWebGL2TranslatorOptions, or explicit module/translator pairs.
 *
 * @throws When duplicate modules are registered, or when an unregistered module is translated.
 */
export function createWebGL2TranslationRouter(
  registrations: readonly WebGL2RouterRegistrationEntry[],
  options: WebGL2TranslationRouterOptions = {}
): WebGL2ShaderTranslationPort {
  const routerId = options.routerId ?? 'aether.rhi.webgl2.translation-router';
  const version = options.version ?? 1;
  const registry = new Map<string, WebGL2ShaderTranslationPort>();

  for (const rawEntry of registrations) {
    const reg = resolveRegistration(rawEntry);
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
    translate(
      input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]
    ): ReturnType<WebGL2ShaderTranslationPort['translate']> {
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

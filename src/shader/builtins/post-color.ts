import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { POST_COLOR_SHADER_GENERATED_ARTIFACT } from './post-color.generated';

export const POST_COLOR_SHADER_ABI_VERSION = 1;
export const POST_COLOR_SHADER_ARTIFACT = POST_COLOR_SHADER_GENERATED_ARTIFACT;
export const POST_COLOR_SHADER_MODULE = POST_COLOR_SHADER_ARTIFACT.modules.wgsl;

/** Uses the committed Naga output for the versioned baseline output transform. */
export const POST_COLOR_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort = Object.freeze({
  translatorId: 'aether.post-color.naga-glsl',
  version: POST_COLOR_SHADER_ABI_VERSION,
  translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
    const emitted =
      POST_COLOR_SHADER_ARTIFACT.modules.glslEs300[`${input.stage}:${input.entryPoint}`];
    const entryPoint = POST_COLOR_SHADER_ARTIFACT.entryPoints.find(
      (entry) => entry.stage === input.stage && entry.name === input.entryPoint
    );
    if (emitted === undefined || entryPoint === undefined)
      throw new Error(`Missing cooked post-color module for "${input.entryPoint}".`);
    const bindings = Object.freeze(
      entryPoint.bindings.map((binding) => {
        if (
          binding.kind !== 'uniform-buffer' &&
          binding.kind !== 'texture' &&
          binding.kind !== 'sampler'
        )
          throw new Error(`Unsupported post-color binding kind "${binding.kind}".`);
        return Object.freeze({
          group: binding.group,
          binding: binding.binding,
          name: binding.name,
          kind: binding.kind
        });
      })
    );
    return Object.freeze({
      source: emitted.source.replace(/^#version 300 es\s*/, ''),
      bindings,
      physicalBindings: Object.freeze(
        bindings.map((binding) =>
          Object.freeze({
            ...binding,
            slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
          })
        )
      ),
      programBindings: Object.freeze(
        emitted.bindings.map((binding) =>
          binding.kind === 'uniform-buffer'
            ? Object.freeze({
                kind: 'uniform-buffer' as const,
                name: binding.name,
                slot: binding.resource.group
              })
            : Object.freeze({
                kind: 'combined-sampler' as const,
                name: binding.name,
                slot: binding.texture.binding
              })
        )
      ),
      targetAbiFingerprint: 'post-color-v1',
      requiredExtensions: EMPTY,
      sourceMap: EMPTY_SOURCE_MAP,
      translatorFingerprint: `${input.entryPoint}:v1`
    });
  }
});

const EMPTY: readonly string[] = Object.freeze([]);
const EMPTY_SOURCE_MAP: readonly Readonly<{ generatedLine: number; authoredLine: number }>[] =
  Object.freeze([]);

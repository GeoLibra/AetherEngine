import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { LIGHT_LIST_WEBGL2_TRANSLATOR } from './light-list-webgl';
import { STANDARD_LIT_WEBGL2_TRANSLATOR } from './standard-lit';
import {
  STANDARD_LIT_LIST_WEBGL2_TRANSLATOR,
  STANDARD_LIT_LIST_WEBGL_SHADER_MODULE
} from './standard-lit-list';

const LIGHT_LIST_ENTRY_POINTS = new Set(['lightListVertex', 'lightListFragment']);

/** Built-in browser translator routing each cooked entry point to its owning subsystem. */
export const BUILT_IN_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort = Object.freeze({
  translatorId: 'aether.builtins.naga-glsl',
  version: 1,
  translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
    if (input.wgsl === STANDARD_LIT_LIST_WEBGL_SHADER_MODULE)
      return STANDARD_LIT_LIST_WEBGL2_TRANSLATOR.translate(input);
    return LIGHT_LIST_ENTRY_POINTS.has(input.entryPoint)
      ? LIGHT_LIST_WEBGL2_TRANSLATOR.translate(input)
      : STANDARD_LIT_WEBGL2_TRANSLATOR.translate(input);
  }
});

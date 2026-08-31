import type {
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderModuleIR,
  ShaderSymbolId,
  SourceSpan
} from '../types';
import {
  binaryExpr,
  constructExpr,
  createStructTypeIR,
  createUniformGlobalIR,
  fieldExpr,
  intrinsicExpr,
  literalExpr,
  shaderType,
  symbolExpr,
  unaryExpr
} from '../ir';
import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { remapVertexClipDepth } from '../../rhi/webgl2/pipeline/clip-depth';
import { emitGlslEsModule } from '../backends/glsl';

export const STANDARD_LIT_SHADER_ABI_VERSION = 1;

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

const span: SourceSpan = {
  uri: 'asset://aether/builtins/standard-lit.flux',
  line: 1,
  column: 1,
  length: 1
};
const positionId = 1 as ShaderSymbolId;
const normalId = 2 as ShaderSymbolId;
const fragmentInputId = 3 as ShaderSymbolId;
const EMPTY_FUNCTIONS: ShaderModuleIR['functions'] = Object.freeze([]);
const EMPTY_VARIANTS: ShaderModuleIR['variants'] = Object.freeze([]);
const EMPTY_REQUIRED_EXTENSIONS: readonly string[] = Object.freeze([]);
const EMPTY_TRANSLATED_SOURCE_MAP: readonly Readonly<{
  generatedLine: number;
  authoredLine: number;
}>[] = Object.freeze([]);

/** Versioned typed shader module for the baseline standard-lit material. */
export const STANDARD_LIT_SHADER_MODULE: ShaderModuleIR = Object.freeze({
  version: 1,
  types: Object.freeze([
    createStructTypeIR('ObjectData', [['world', 'mat4x4<f32>']]),
    createStructTypeIR('ViewData', [['viewProjection', 'mat4x4<f32>']]),
    createStructTypeIR('MaterialData', [
      ['baseColor', 'vec4<f32>'],
      ['metallic', 'f32'],
      ['roughness', 'f32']
    ]),
    createStructTypeIR('DirectionalLightData', [
      ['direction', 'vec3<f32>'],
      ['illuminance', 'f32'],
      ['color', 'vec3<f32>']
    ]),
    createStructTypeIR('StandardLitVertexOutput', [
      { name: 'position', type: 'vec4<f32>', builtin: 'position' },
      { name: 'normal', type: 'vec3<f32>', location: 0 }
    ]),
    createStructTypeIR('StandardLitFragmentInput', [
      { name: 'normal', type: 'vec3<f32>', location: 0 }
    ])
  ]),
  globals: Object.freeze([
    createUniformGlobalIR(10, 'objectData', 'ObjectData', 0, 0, span),
    createUniformGlobalIR(11, 'viewData', 'ViewData', 1, 0, span),
    createUniformGlobalIR(12, 'materialData', 'MaterialData', 2, 0, span),
    createUniformGlobalIR(13, 'lightData', 'DirectionalLightData', 3, 0, span)
  ]),
  functions: EMPTY_FUNCTIONS,
  entryPoints: Object.freeze([
    {
      id: 1 as ShaderFunctionId,
      name: 'standardLitVertex',
      stage: 'vertex' as const,
      parameters: Object.freeze([
        Object.freeze({
          id: positionId,
          name: 'position',
          type: shaderType('vec3<f32>'),
          location: 0,
          span
        }),
        Object.freeze({
          id: normalId,
          name: 'normal',
          type: shaderType('vec3<f32>'),
          location: 1,
          span
        })
      ]),
      returnType: shaderType('StandardLitVertexOutput'),
      body: Object.freeze([
        Object.freeze({
          kind: 'return' as const,
          value: constructExpr('StandardLitVertexOutput', [clipPosition(), worldNormal()], span),
          span
        })
      ]),
      span
    },
    {
      id: 2 as ShaderFunctionId,
      name: 'standardLitFragment',
      stage: 'fragment' as const,
      parameters: Object.freeze([
        Object.freeze({
          id: fragmentInputId,
          name: 'fragmentInput',
          type: shaderType('StandardLitFragmentInput'),
          span
        })
      ]),
      returnType: shaderType('vec4<f32>'),
      returnLocation: 0,
      body: Object.freeze([
        Object.freeze({
          kind: 'return' as const,
          value: fragmentColor(),
          span
        })
      ]),
      span
    }
  ]),
  variants: EMPTY_VARIANTS,
  sourceMap: Object.freeze({ spans: Object.freeze([span]) }),
  sourceClosureHash: 'aether-standard-lit-ir-v1'
});

function clipPosition(): ShaderExpressionIR {
  return binaryExpr(
    '*',
    fieldExpr(symbolExpr(11, 'viewData', 'ViewData', span), 'viewProjection', 'mat4x4<f32>', span),
    binaryExpr(
      '*',
      fieldExpr(symbolExpr(10, 'objectData', 'ObjectData', span), 'world', 'mat4x4<f32>', span),
      constructExpr(
        'vec4<f32>',
        [symbolExpr(positionId, 'position', 'vec3<f32>', span), literalExpr(1, 'f32', span)],
        span
      ),
      'vec4<f32>',
      span
    ),
    'vec4<f32>',
    span
  );
}

function worldNormal(): ShaderExpressionIR {
  const transformed = binaryExpr(
    '*',
    fieldExpr(symbolExpr(10, 'objectData', 'ObjectData', span), 'world', 'mat4x4<f32>', span),
    constructExpr(
      'vec4<f32>',
      [symbolExpr(normalId, 'normal', 'vec3<f32>', span), literalExpr(0, 'f32', span)],
      span
    ),
    'vec4<f32>',
    span
  );
  return intrinsicExpr(
    'normalize',
    [fieldExpr(transformed, 'xyz', 'vec3<f32>', span)],
    'vec3<f32>',
    span
  );
}

function fragmentColor(): ShaderExpressionIR {
  const inputNormal = fieldExpr(
    symbolExpr(fragmentInputId, 'fragmentInput', 'StandardLitFragmentInput', span),
    'normal',
    'vec3<f32>',
    span
  );
  const lightDirection = fieldExpr(
    symbolExpr(13, 'lightData', 'DirectionalLightData', span),
    'direction',
    'vec3<f32>',
    span
  );
  const lambert = intrinsicExpr(
    'max',
    [
      intrinsicExpr(
        'dot',
        [
          intrinsicExpr('normalize', [inputNormal], 'vec3<f32>', span),
          unaryExpr(
            '-',
            intrinsicExpr('normalize', [lightDirection], 'vec3<f32>', span),
            'vec3<f32>',
            span
          )
        ],
        'f32',
        span
      ),
      literalExpr(0, 'f32', span)
    ],
    'f32',
    span
  );
  const factor = binaryExpr(
    '+',
    literalExpr(0.15, 'f32', span),
    binaryExpr('*', literalExpr(0.85, 'f32', span), lambert, 'f32', span),
    'f32',
    span
  );
  const baseColor = fieldExpr(
    symbolExpr(12, 'materialData', 'MaterialData', span),
    'baseColor',
    'vec4<f32>',
    span
  );
  const lit = binaryExpr(
    '*',
    binaryExpr(
      '*',
      fieldExpr(baseColor, 'rgb', 'vec3<f32>', span),
      fieldExpr(
        symbolExpr(13, 'lightData', 'DirectionalLightData', span),
        'color',
        'vec3<f32>',
        span
      ),
      'vec3<f32>',
      span
    ),
    factor,
    'vec3<f32>',
    span
  );
  return constructExpr('vec4<f32>', [lit, fieldExpr(baseColor, 'a', 'f32', span)], span);
}

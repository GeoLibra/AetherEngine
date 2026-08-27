import type {
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderModuleIR,
  ShaderSymbolId,
  ShaderTypeId,
  SourceSpan
} from '../types';
import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { emitGlslEsModule } from '../backends/glsl-es';

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
        ? emitted.replace(
            /(?=\n\s*return;\n}\s*$)/,
            '\n  gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;'
          )
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
    structure('ObjectData', [['world', 'mat4x4<f32>']]),
    structure('ViewData', [['viewProjection', 'mat4x4<f32>']]),
    structure('MaterialData', [
      ['baseColor', 'vec4<f32>'],
      ['metallic', 'f32'],
      ['roughness', 'f32']
    ]),
    structure('DirectionalLightData', [
      ['direction', 'vec3<f32>'],
      ['illuminance', 'f32'],
      ['color', 'vec3<f32>']
    ]),
    {
      kind: 'struct' as const,
      name: 'StandardLitVertexOutput',
      fields: Object.freeze([
        Object.freeze({ name: 'position', type: 'vec4<f32>', builtin: 'position' as const }),
        Object.freeze({ name: 'normal', type: 'vec3<f32>', location: 0 })
      ])
    },
    {
      kind: 'struct' as const,
      name: 'StandardLitFragmentInput',
      fields: Object.freeze([Object.freeze({ name: 'normal', type: 'vec3<f32>', location: 0 })])
    }
  ]),
  globals: Object.freeze([
    uniform(10, 'objectData', 'ObjectData', 0),
    uniform(11, 'viewData', 'ViewData', 1),
    uniform(12, 'materialData', 'MaterialData', 2),
    uniform(13, 'lightData', 'DirectionalLightData', 3)
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
          value: construct('StandardLitVertexOutput', [clipPosition(), worldNormal()]),
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

function structure(name: string, fields: readonly (readonly [string, string])[]) {
  return Object.freeze({
    kind: 'struct' as const,
    name,
    fields: Object.freeze(fields.map(([field, type]) => Object.freeze({ name: field, type })))
  });
}

function uniform(id: number, name: string, type: string, group: number) {
  return Object.freeze({
    id: id as ShaderSymbolId,
    name,
    type,
    addressSpace: 'uniform' as const,
    access: 'read' as const,
    group,
    binding: 0,
    span
  });
}

function clipPosition(): ShaderExpressionIR {
  return binary(
    '*',
    field(symbol(11, 'viewData', 'ViewData'), 'viewProjection', 'mat4x4<f32>'),
    binary(
      '*',
      field(symbol(10, 'objectData', 'ObjectData'), 'world', 'mat4x4<f32>'),
      construct('vec4<f32>', [symbol(positionId, 'position', 'vec3<f32>'), literal(1)]),
      'vec4<f32>'
    ),
    'vec4<f32>'
  );
}

function worldNormal(): ShaderExpressionIR {
  const transformed = binary(
    '*',
    field(symbol(10, 'objectData', 'ObjectData'), 'world', 'mat4x4<f32>'),
    construct('vec4<f32>', [symbol(normalId, 'normal', 'vec3<f32>'), literal(0)]),
    'vec4<f32>'
  );
  return intrinsic('normalize', [field(transformed, 'xyz', 'vec3<f32>')], 'vec3<f32>');
}

function fragmentColor(): ShaderExpressionIR {
  const inputNormal = field(
    symbol(fragmentInputId, 'fragmentInput', 'StandardLitFragmentInput'),
    'normal',
    'vec3<f32>'
  );
  const lightDirection = field(
    symbol(13, 'lightData', 'DirectionalLightData'),
    'direction',
    'vec3<f32>'
  );
  const lambert = intrinsic(
    'max',
    [
      intrinsic(
        'dot',
        [
          intrinsic('normalize', [inputNormal], 'vec3<f32>'),
          unary('-', intrinsic('normalize', [lightDirection], 'vec3<f32>'), 'vec3<f32>')
        ],
        'f32'
      ),
      literal(0)
    ],
    'f32'
  );
  const factor = binary('+', literal(0.15), binary('*', literal(0.85), lambert, 'f32'), 'f32');
  const baseColor = field(symbol(12, 'materialData', 'MaterialData'), 'baseColor', 'vec4<f32>');
  const lit = binary(
    '*',
    binary(
      '*',
      field(baseColor, 'rgb', 'vec3<f32>'),
      field(symbol(13, 'lightData', 'DirectionalLightData'), 'color', 'vec3<f32>'),
      'vec3<f32>'
    ),
    factor,
    'vec3<f32>'
  );
  return construct('vec4<f32>', [lit, field(baseColor, 'a', 'f32')]);
}

function shaderType(type: string): ShaderTypeId {
  return type as ShaderTypeId;
}

function symbol(id: number | ShaderSymbolId, name: string, type: string): ShaderExpressionIR {
  return { kind: 'symbol', symbol: id as ShaderSymbolId, name, type: shaderType(type), span };
}

function literal(value: number): ShaderExpressionIR {
  return { kind: 'literal', value, type: shaderType('f32'), span };
}

function field(base: ShaderExpressionIR, name: string, type: string): ShaderExpressionIR {
  return { kind: 'field', base, field: name, type: shaderType(type), span };
}

function construct(type: string, arguments_: readonly ShaderExpressionIR[]): ShaderExpressionIR {
  return { kind: 'construct', type: shaderType(type), arguments: arguments_, span };
}

function binary(
  operator: string,
  left: ShaderExpressionIR,
  right: ShaderExpressionIR,
  type: string
): ShaderExpressionIR {
  return { kind: 'binary', operator, left, right, type: shaderType(type), span };
}

function unary(operator: string, operand: ShaderExpressionIR, type: string): ShaderExpressionIR {
  return { kind: 'unary', operator, operand, type: shaderType(type), span };
}

function intrinsic(
  name: string,
  arguments_: readonly ShaderExpressionIR[],
  type: string
): ShaderExpressionIR {
  return {
    kind: 'intrinsic',
    intrinsic: name,
    arguments: arguments_,
    type: shaderType(type),
    span
  };
}

import { describe, expect, test } from 'vitest';
import { emitGlslEsModule, emitWgslModule } from '../../src/shader/experimental/flux/backends';
import type {
  ShaderFunctionId,
  ShaderModuleIR,
  ShaderSymbolId,
  ShaderTypeId
} from '../../src/shader/types';

const span = { uri: 'asset://aether/stage-io.flux', line: 1, column: 1, length: 1 };
const position = 1 as ShaderSymbolId;
const normal = 2 as ShaderSymbolId;
const fragmentInput = 3 as ShaderSymbolId;

function stageIoModule(): ShaderModuleIR {
  return {
    version: 1,
    types: [
      {
        kind: 'struct',
        name: 'VertexOutput',
        fields: [
          { name: 'position', type: 'vec4<f32>', builtin: 'position' },
          { name: 'normal', type: 'vec3<f32>', location: 0 }
        ]
      },
      {
        kind: 'struct',
        name: 'FragmentInput',
        fields: [{ name: 'normal', type: 'vec3<f32>', location: 0 }]
      }
    ],
    globals: [],
    functions: [],
    entryPoints: [
      {
        id: 1 as ShaderFunctionId,
        name: 'vertexMain',
        stage: 'vertex',
        parameters: [
          { id: position, name: 'position', type: 'vec3<f32>' as ShaderTypeId, location: 0, span },
          { id: normal, name: 'normal', type: 'vec3<f32>' as ShaderTypeId, location: 1, span }
        ],
        returnType: 'VertexOutput' as ShaderTypeId,
        body: [
          {
            kind: 'return',
            value: {
              kind: 'construct',
              type: 'VertexOutput' as ShaderTypeId,
              arguments: [
                {
                  kind: 'construct',
                  type: 'vec4<f32>' as ShaderTypeId,
                  arguments: [
                    {
                      kind: 'symbol',
                      symbol: position,
                      name: 'position',
                      type: 'vec3<f32>' as ShaderTypeId,
                      span
                    },
                    { kind: 'literal', value: 1, type: 'f32' as ShaderTypeId, span }
                  ],
                  span
                },
                {
                  kind: 'symbol',
                  symbol: normal,
                  name: 'normal',
                  type: 'vec3<f32>' as ShaderTypeId,
                  span
                }
              ],
              span
            },
            span
          }
        ],
        span
      },
      {
        id: 2 as ShaderFunctionId,
        name: 'fragmentMain',
        stage: 'fragment',
        parameters: [
          {
            id: fragmentInput,
            name: 'input',
            type: 'FragmentInput' as ShaderTypeId,
            span
          }
        ],
        returnType: 'vec4<f32>' as ShaderTypeId,
        returnLocation: 0,
        body: [
          {
            kind: 'return',
            value: {
              kind: 'construct',
              type: 'vec4<f32>' as ShaderTypeId,
              arguments: [
                {
                  kind: 'field',
                  base: {
                    kind: 'symbol',
                    symbol: fragmentInput,
                    name: 'input',
                    type: 'FragmentInput' as ShaderTypeId,
                    span
                  },
                  field: 'normal',
                  type: 'vec3<f32>' as ShaderTypeId,
                  span
                },
                { kind: 'literal', value: 1, type: 'f32' as ShaderTypeId, span }
              ],
              span
            },
            span
          }
        ],
        span
      }
    ],
    variants: [],
    sourceMap: { spans: [] },
    sourceClosureHash: 'stage-io-v1'
  };
}

describe('typed shader stage IO', () => {
  test('emits attributed WGSL interface structs', () => {
    const source = emitWgslModule(stageIoModule());

    expect(source).toContain('@builtin(position) position: vec4<f32>');
    expect(source).toContain('@location(0) normal: vec3<f32>');
    expect(source).toContain('@vertex fn vertexMain');
    expect(source).toContain('@fragment fn fragmentMain');
  });

  test('flattens typed vertex outputs and fragment inputs for GLSL ES', () => {
    const module = stageIoModule();
    const vertex = emitGlslEsModule(module, 'vertexMain');
    const fragment = emitGlslEsModule(module, 'fragmentMain');

    expect(vertex).toContain('out vec3 aether_varying_normal;');
    expect(vertex).toContain('gl_Position = vec4(position, 1.0);');
    expect(vertex).toContain('aether_varying_normal = normal;');
    expect(fragment).toContain('in vec3 aether_varying_normal;');
    expect(fragment).toContain('FragmentInput input = FragmentInput(aether_varying_normal);');
    expect(fragment).toContain('aether_fragment_output = vec4(input.normal, 1.0);');
  });
});

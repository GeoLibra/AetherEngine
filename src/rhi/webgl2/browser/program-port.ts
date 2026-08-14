import type { WebGL2NativeContextPort } from '../native-types';
import type { WebGL2BindingManifestEntry } from '../shader-types';
import { constant } from './capability-query';
import { glCall, glObject } from './gl-call';
import type { BrowserWebGL2Object } from './types';

export function createBrowserWebGL2ProgramPort(
  gl: BrowserWebGL2Object
): Pick<
  WebGL2NativeContextPort,
  'createProgram' | 'getProgramReflection' | 'deleteProgram' | 'useProgram'
> {
  const reflections = new WeakMap<object, readonly WebGL2BindingManifestEntry[]>();
  return {
    createProgram(descriptor) {
      const vertexSource = requiredString(descriptor, 'vertexSource');
      const fragmentSource = requiredString(descriptor, 'fragmentSource');
      const vertex = compile(gl, constant(gl, 'VERTEX_SHADER'), vertexSource, 'vertex');
      let fragment: object;
      try {
        fragment = compile(gl, constant(gl, 'FRAGMENT_SHADER'), fragmentSource, 'fragment');
      } catch (error) {
        glCall(gl, 'deleteShader', [vertex]);
        throw error;
      }
      let program: object | undefined;
      try {
        program = glObject(gl, 'createProgram');
        glCall(gl, 'attachShader', [program, vertex]);
        glCall(gl, 'attachShader', [program, fragment]);
        glCall(gl, 'linkProgram', [program]);
        if (glCall(gl, 'getProgramParameter', [program, constant(gl, 'LINK_STATUS')]) !== true)
          throw new Error(
            formatProgramLinkError(
              String(glCall(gl, 'getProgramInfoLog', [program]) ?? 'No driver log.'),
              vertexSource,
              fragmentSource
            )
          );
      } catch (error) {
        if (program !== undefined) glCall(gl, 'deleteProgram', [program]);
        throw error;
      } finally {
        glCall(gl, 'deleteShader', [vertex]);
        glCall(gl, 'deleteShader', [fragment]);
      }
      const bindings = Array.isArray(descriptor.bindings)
        ? (descriptor.bindings as readonly WebGL2BindingManifestEntry[]).map((entry) => ({
            ...entry
          }))
        : [];
      reflections.set(program, bindings);
      return program;
    },
    getProgramReflection(program) {
      return reflections.get(program) ?? [];
    },
    deleteProgram(program): void {
      reflections.delete(program);
      glCall(gl, 'deleteProgram', [program]);
    },
    useProgram(program): void {
      glCall(gl, 'useProgram', [program]);
    }
  };
}

function compile(
  gl: BrowserWebGL2Object,
  type: number,
  source: string,
  stage: 'vertex' | 'fragment'
): object {
  const shader = glObject(gl, 'createShader', [type]);
  glCall(gl, 'shaderSource', [shader, source]);
  glCall(gl, 'compileShader', [shader]);
  if (glCall(gl, 'getShaderParameter', [shader, constant(gl, 'COMPILE_STATUS')]) !== true) {
    const log = glCall(gl, 'getShaderInfoLog', [shader]);
    glCall(gl, 'deleteShader', [shader]);
    throw new Error(formatShaderError(stage, String(log ?? 'No driver log.'), source));
  }
  return shader;
}

function formatShaderError(stage: 'vertex' | 'fragment', log: string, source: string): string {
  return `WebGL2 ${stage} shader compilation failed:\n${log}\n--- Generated source ---\n${numberSource(source)}`;
}

function formatProgramLinkError(log: string, vertexSource: string, fragmentSource: string): string {
  return `WebGL2 program link failed:\n${log}\n--- vertex generated source ---\n${numberSource(vertexSource)}\n--- fragment generated source ---\n${numberSource(fragmentSource)}`;
}

function numberSource(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function requiredString(value: Readonly<Record<string, unknown>>, name: string): string {
  const result = value[name];
  if (typeof result !== 'string') throw new TypeError(`WebGL2 program ${name} must be a string.`);
  return result;
}

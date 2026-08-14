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
      const vertex = compile(
        gl,
        constant(gl, 'VERTEX_SHADER'),
        requiredString(descriptor, 'vertexSource')
      );
      const fragment = compile(
        gl,
        constant(gl, 'FRAGMENT_SHADER'),
        requiredString(descriptor, 'fragmentSource')
      );
      const program = glObject(gl, 'createProgram');
      try {
        glCall(gl, 'attachShader', [program, vertex]);
        glCall(gl, 'attachShader', [program, fragment]);
        glCall(gl, 'linkProgram', [program]);
        if (glCall(gl, 'getProgramParameter', [program, constant(gl, 'LINK_STATUS')]) !== true)
          throw new Error(
            String(glCall(gl, 'getProgramInfoLog', [program]) ?? 'WebGL2 program link failed.')
          );
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

function compile(gl: BrowserWebGL2Object, type: number, source: string): object {
  const shader = glObject(gl, 'createShader', [type]);
  glCall(gl, 'shaderSource', [shader, source]);
  glCall(gl, 'compileShader', [shader]);
  if (glCall(gl, 'getShaderParameter', [shader, constant(gl, 'COMPILE_STATUS')]) !== true) {
    const log = glCall(gl, 'getShaderInfoLog', [shader]);
    glCall(gl, 'deleteShader', [shader]);
    throw new Error(String(log ?? 'WebGL2 shader compilation failed.'));
  }
  return shader;
}

function requiredString(value: Readonly<Record<string, unknown>>, name: string): string {
  const result = value[name];
  if (typeof result !== 'string') throw new TypeError(`WebGL2 program ${name} must be a string.`);
  return result;
}

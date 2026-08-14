import type { BrowserWebGL2Object } from './types';

export function glCall(
  gl: BrowserWebGL2Object,
  name: string,
  args: readonly unknown[] = []
): unknown {
  const method = Reflect.get(gl, name);
  if (typeof method !== 'function') throw new Error(`WebGL2 context does not implement ${name}().`);
  return Reflect.apply(method, gl, args);
}

export function glObject(gl: BrowserWebGL2Object, name: string): object {
  const value = glCall(gl, name);
  if (typeof value !== 'object' || value === null)
    throw new Error(`WebGL2 ${name}() returned null.`);
  return value;
}

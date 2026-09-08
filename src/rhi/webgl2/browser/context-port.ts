import type { WebGL2NativeContextPort } from '../types';
import { WEBGL2_CLIP_CONTROL_EXTENSION } from '../pipeline/clip-depth';
import {
  COLOR_BUFFER_FLOAT_EXTENSION,
  TEXTURE_FLOAT_LINEAR_EXTENSION,
  queryWebGL2Extensions,
  queryWebGL2Formats,
  queryWebGL2Limits,
  queryWebGL2Precision,
  constant
} from './capability-query';
import { initializeWebGL2StateDefaults } from './state-defaults';
import { createBrowserWebGL2OperationPort } from './operations';
import type {
  BrowserWebGL2Canvas,
  BrowserWebGL2Context,
  BrowserWebGL2ContextOptions
} from './types';

export function createBrowserWebGL2ContextPort(
  canvas: BrowserWebGL2Canvas,
  options: BrowserWebGL2ContextOptions = {}
): WebGL2NativeContextPort | null {
  const native = canvas.getContext(
    'webgl2',
    Object.freeze({
      alpha: options.alpha ?? true,
      antialias: false,
      depth: options.depth ?? true,
      stencil: options.stencil ?? false,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      powerPreference: options.powerPreference ?? 'default'
    })
  );
  if (!isContext(native)) return null;
  const gl = native;
  const extensions = queryWebGL2Extensions(gl);
  if (extensions.has(COLOR_BUFFER_FLOAT_EXTENSION)) {
    gl.getExtension?.(COLOR_BUFFER_FLOAT_EXTENSION);
  }
  if (extensions.has(TEXTURE_FLOAT_LINEAR_EXTENSION)) {
    gl.getExtension?.(TEXTURE_FLOAT_LINEAR_EXTENSION);
  }
  if (options.clipControl === false) extensions.delete(WEBGL2_CLIP_CONTROL_EXTENSION);
  const clipControl = extensions.has(WEBGL2_CLIP_CONTROL_EXTENSION)
    ? gl.getExtension?.(WEBGL2_CLIP_CONTROL_EXTENSION)
    : undefined;
  initializeWebGL2StateDefaults(gl);
  let resolveLost!: (info: { reason?: string; message?: string }) => void;
  let settled = false;
  const lost = new Promise<{ reason?: string; message?: string }>((resolve) => {
    resolveLost = resolve;
  });
  let resolveRestored!: () => void;
  let restoreSettled = false;
  const restored = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });
  const onLost = (event: unknown): void => {
    if (settled) return;
    settled = true;
    const preventDefault = objectMethod(event, 'preventDefault');
    preventDefault?.();
    const message = stringProperty(event, 'statusMessage');
    resolveLost({ reason: 'context-lost', ...(message === undefined ? {} : { message }) });
  };
  const onRestored = (): void => {
    if (!settled || restoreSettled) return;
    initializeWebGL2StateDefaults(gl);
    restoreSettled = true;
    resolveRestored();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return {
    ...createBrowserWebGL2OperationPort(gl),
    info: contextInfo(gl),
    extensions,
    limits: queryWebGL2Limits(gl),
    formats: queryWebGL2Formats(gl, extensions),
    precision: queryWebGL2Precision(gl),
    lost,
    restored,
    ...(clipControl === undefined || clipControl === null
      ? {}
      : {
          setClipControl(): void {
            const method = Reflect.get(clipControl, 'clipControlEXT');
            if (typeof method !== 'function')
              throw new Error(`${WEBGL2_CLIP_CONTROL_EXTENSION} does not expose clipControlEXT.`);
            Reflect.apply(method, clipControl, [
              extensionConstant(clipControl, gl, 'LOWER_LEFT_EXT', 'LOWER_LEFT'),
              extensionConstant(clipControl, gl, 'ZERO_TO_ONE_EXT', 'ZERO_TO_ONE')
            ]);
          }
        }),
    destroy(): void {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    }
  };
}

function extensionConstant(
  extension: object,
  gl: BrowserWebGL2Context,
  extensionName: string,
  contextName: string
): number {
  const value = Reflect.get(extension, extensionName);
  return typeof value === 'number' ? value : constant(gl, contextName);
}

function contextInfo(gl: BrowserWebGL2Context) {
  const vendor = stringParameter(gl, 'VENDOR');
  const renderer = stringParameter(gl, 'RENDERER');
  return Object.freeze({
    name: 'WebGL2',
    ...(vendor === undefined ? {} : { vendor }),
    ...(renderer === undefined ? {} : { renderer })
  });
}

function isContext(value: unknown): value is BrowserWebGL2Context {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getParameter') === 'function'
  );
}

function stringParameter(gl: BrowserWebGL2Context, name: string): string | undefined {
  const value = gl.getParameter(constant(gl, name));
  return typeof value === 'string' ? value : undefined;
}

function stringProperty(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Reflect.get(value, name);
  return typeof property === 'string' ? property : undefined;
}

function objectMethod(value: unknown, name: string): (() => void) | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const method = Reflect.get(value, name);
  return typeof method === 'function' ? () => Reflect.apply(method, value, []) : undefined;
}

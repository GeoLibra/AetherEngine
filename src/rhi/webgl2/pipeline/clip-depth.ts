import type { WebGL2NativeContextPort } from '../types';

export const WEBGL2_CLIP_CONTROL_EXTENSION = 'EXT_clip_control';

// vertex-remap requires the vertex epilogue to lower engine z with z_gl = 2 * z_engine - w.
export type WebGL2ClipDepthMode = 'zero-to-one' | 'vertex-remap';

export function selectWebGL2ClipDepthMode(extensions: ReadonlySet<string>): WebGL2ClipDepthMode {
  return extensions.has(WEBGL2_CLIP_CONTROL_EXTENSION) ? 'zero-to-one' : 'vertex-remap';
}

export function initializeWebGL2ClipDepth(
  native: WebGL2NativeContextPort,
  mode: WebGL2ClipDepthMode
): void {
  if (mode !== 'zero-to-one') return;
  if (native.setClipControl === undefined) {
    throw new Error(
      `Native WebGL2 context advertises ${WEBGL2_CLIP_CONTROL_EXTENSION} but does not expose setClipControl.`
    );
  }
  native.setClipControl('lower-left', 'zero-to-one');
}

/**
 * Remaps the vertex shader gl_Position.z from WebGPU zero-to-one [0, 1] range to OpenGL [-1, 1] range
 * by injecting `gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;` before returning in main.
 */
export function remapVertexClipDepth(source: string): string {
  return source.replace(
    /(?=\n\s*return;\n}\s*$)/,
    '\n  gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;'
  );
}

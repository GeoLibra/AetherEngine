import type { WebGL2NativeContextPort } from './native-types';

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

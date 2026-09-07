/**
 * @file Packs uniform data for Skybox / HDR Background fullscreen rendering.
 * Conforms to the SkyboxUniforms layout defined in engine/design/v2/04-rendering/10-skybox-background.md
 * and src/shader/builtins/skybox/skybox.wgsl.
 */

import type { FullscreenVertexRays } from '../coordinates';

export interface SkyboxUniformOptions {
  readonly vertexRays: FullscreenVertexRays;
  readonly invProj: ArrayLike<number>;
  readonly envRot: ArrayLike<number>;
  readonly intensity: number;
  readonly multiplier: number;
  readonly maxLod: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly reconstructionMode: 'vertex' | 'fragment';
  readonly representation: 'panorama' | 'radiance-level-zero' | 'solid';
  readonly depthMode: 'standard' | 'reverse';
  readonly projectionKind: 'perspective' | 'orthographic';
  readonly solidColor?: readonly [number, number, number] | undefined;
}

/** Byte size of SkyboxUniforms in WGSL (60 f32 = 240 bytes). */
export const SKYBOX_UNIFORM_BYTE_SIZE = 240;

/**
 * Serializes uniform values into a 240-byte Float32Array buffer matching WGSL SkyboxUniforms.
 */
export function packSkyboxUniforms(options: SkyboxUniformOptions): Float32Array {
  const data = new Float32Array(60);

  // 0..15: ray0 (0..3), ray1 (4..7), ray2 (8..11), padding0 (12..15)
  data[0] = options.vertexRays.ray0[0];
  data[1] = options.vertexRays.ray0[1];
  data[2] = options.vertexRays.ray0[2];
  data[3] = 0.0;

  data[4] = options.vertexRays.ray1[0];
  data[5] = options.vertexRays.ray1[1];
  data[6] = options.vertexRays.ray1[2];
  data[7] = 0.0;

  data[8] = options.vertexRays.ray2[0];
  data[9] = options.vertexRays.ray2[1];
  data[10] = options.vertexRays.ray2[2];
  data[11] = 0.0;

  data[12] = 0.0;
  data[13] = 0.0;
  data[14] = 0.0;
  data[15] = 0.0;

  // 16..31: invProj mat4x4<f32>
  for (let i = 0; i < 16; i++) {
    data[16 + i] = options.invProj[i] ?? 0.0;
  }

  // 32..47: envRot mat4x4<f32>
  for (let i = 0; i < 16; i++) {
    data[32 + i] = options.envRot[i] ?? 0.0;
  }

  // 48..51: params vec4<f32>
  data[48] = options.intensity * options.multiplier;
  data[49] = options.maxLod;
  data[50] = options.textureWidth;
  data[51] = options.textureHeight;

  // 52..55: flags vec4<f32>
  data[52] = options.reconstructionMode === 'fragment' ? 1.0 : 0.0;
  data[53] =
    options.representation === 'solid'
      ? 2.0
      : options.representation === 'radiance-level-zero'
        ? 1.0
        : 0.0;
  data[54] = options.depthMode === 'reverse' ? 1.0 : 0.0;
  data[55] = options.projectionKind === 'orthographic' ? 1.0 : 0.0;

  // 56..59: solidColor vec4<f32>
  if (options.solidColor !== undefined) {
    data[56] = options.solidColor[0];
    data[57] = options.solidColor[1];
    data[58] = options.solidColor[2];
    data[59] = 1.0;
  } else {
    data[56] = 0.0;
    data[57] = 0.0;
    data[58] = 0.0;
    data[59] = 1.0;
  }

  return data;
}

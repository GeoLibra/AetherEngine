/**
 * @file Declares background uniform and texture graph handles for RenderGraph execution.
 */

import type { BufferHandle, RenderGraphBuilder, TextureHandle } from '../../../render-graph';
import type { PreparedBackgroundFrame } from '../prepare/background-preparation';

export interface BackgroundGraphContribution {
  readonly uniformBuffer: BufferHandle;
  readonly skyTexture: TextureHandle;
}

/**
 * Registers background uniform buffer and texture leases into the active RenderGraphBuilder.
 */
export function contributeBackground(
  graph: RenderGraphBuilder,
  background: PreparedBackgroundFrame,
  viewId: string
): BackgroundGraphContribution {
  if (background.uniformBuffer === undefined || background.texture === undefined) {
    throw new Error('Prepared background frame is missing required GPU resources.');
  }

  const uniformBuffer = graph.createBuffer(
    { size: background.uniformBuffer.size, usage: ['uniform'] },
    {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: `${viewId}:skybox-uniform` }
      }
    }
  );

  const skyTexture = graph.createTexture(
    {
      width: background.texture.width,
      height: background.texture.height,
      depthOrArrayLayers: background.texture.depthOrArrayLayers,
      mipLevelCount: background.texture.descriptor.mipLevelCount ?? 1,
      sampleCount: background.texture.descriptor.sampleCount ?? 1,
      format: background.texture.format,
      usage: ['sampled']
    },
    {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: `${viewId}:skybox-texture` }
      }
    }
  );

  return Object.freeze({ uniformBuffer, skyTexture });
}

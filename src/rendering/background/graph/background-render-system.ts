/**
 * @file RenderSystem descriptor for fullscreen Background (Skybox / HDR panorama / solid) pass.
 * Conforms to engine/design/v2/04-rendering/10-skybox-background.md section 8.
 */

import type {
  BufferHandle,
  PassBuilder,
  RenderSystemConditionContext,
  RestrictedPassContext,
  TextureHandle
} from '../../../render-graph';
import type { PreparedBackgroundFrame } from '../prepare/background-preparation';

export interface BackgroundRenderSystemInput {
  readonly viewId: string;
  readonly prepared: PreparedBackgroundFrame;
  readonly colorTarget: TextureHandle;
  readonly depthTarget?: TextureHandle | undefined;
  readonly uniformBuffer: BufferHandle;
  readonly skyTexture: TextureHandle;
  readonly width: number;
  readonly height: number;
  readonly publishColor?: (color: TextureHandle) => void;
}

/**
 * Creates one per-view Background RenderSystem that draws a fullscreen triangle before opaque geometry.
 */
export function createBackgroundRenderSystem(input: BackgroundRenderSystemInput) {
  return {
    id: `background-${input.viewId}`,
    scope: 'per-view' as const,
    runIf: ({ view }: RenderSystemConditionContext) => view?.id === input.viewId,
    setup(pass: PassBuilder) {
      const color = pass.writeTexture(input.colorTarget, 'color-attachment');
      input.publishColor?.(color);
      const depth =
        input.depthTarget !== undefined
          ? pass.writeTexture(input.depthTarget, 'depth-stencil-attachment')
          : undefined;
      const uniform = pass.readBuffer(input.uniformBuffer, 'uniform');
      const skyTexture = pass.readTexture(input.skyTexture, 'sampled');
      return Object.freeze({ color, depth, uniform, skyTexture });
    },
    run(
      context: RestrictedPassContext,
      resources: {
        color: TextureHandle;
        depth: TextureHandle | undefined;
        uniform: BufferHandle;
        skyTexture: TextureHandle;
      }
    ) {
      if (
        input.prepared.status !== 'ready' ||
        input.prepared.pipelineToken === undefined ||
        input.prepared.uniformLayoutToken === undefined ||
        input.prepared.textureLayoutToken === undefined
      ) {
        return;
      }

      const uniformGroup = context.device.createBindGroup({
        label: 'aether-skybox-uniforms',
        layout: context.bindGroupLayout(input.prepared.uniformLayoutToken),
        entries: [{ binding: 0, resource: context.buffer(resources.uniform, 'uniform') }]
      });

      const textureGroup = context.device.createBindGroup({
        label: 'aether-skybox-texture',
        layout: context.bindGroupLayout(input.prepared.textureLayoutToken),
        entries: [
          { binding: 0, resource: context.texture(resources.skyTexture, 'sampled') },
          {
            binding: 1,
            resource: context.device.createSampler({
              minFilter: 'linear',
              magFilter: 'linear',
              mipmapFilter: 'linear',
              addressModeU: 'repeat',
              addressModeV: 'clamp-to-edge'
            })
          }
        ]
      });

      const pipeline = context.renderPipeline(input.prepared.pipelineToken);
      const raster = context.beginRaster({
        label: 'background-pass',
        colorAttachments: [
          {
            texture: resources.color,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 }
          }
        ]
      });

      raster.setViewport(0, 0, input.width, input.height, 0, 1);
      raster.setScissorRect(0, 0, input.width, input.height);
      raster.setPipeline(pipeline);
      raster.setBindGroup(0, uniformGroup);
      raster.setBindGroup(1, textureGroup);
      raster.draw(3);
      raster.end();
    }
  };
}

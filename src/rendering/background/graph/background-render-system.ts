/**
 * @file RenderSystem descriptor for fullscreen Background (Skybox / HDR panorama / solid) pass.
 * Conforms to engine/design/v2/04-rendering/10-skybox-background.md section 8.
 */

import type {
  BufferHandle,
  RasterPassBuilder,
  RasterPassContext,
  RasterRenderSystemDescriptor,
  RenderSystemConditionContext,
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
  readonly publishDepth?: (depth: TextureHandle) => void;
}

export interface BackgroundPassResources {
  readonly color: TextureHandle;
  readonly depth: TextureHandle | undefined;
  readonly uniform: BufferHandle;
  readonly skyTexture: TextureHandle;
}

/**
 * Creates one per-view Background RenderSystem that draws a fullscreen triangle before opaque geometry.
 */
export function createBackgroundRenderSystem(
  input: BackgroundRenderSystemInput
): RasterRenderSystemDescriptor<BackgroundPassResources> {
  return {
    kind: 'raster',
    id: `background-${input.viewId}`,
    scope: 'per-view',
    runIf: ({ view }: RenderSystemConditionContext) => view?.id === input.viewId,
    setup(pass: RasterPassBuilder): BackgroundPassResources {
      if (input.prepared.status === 'ready' && input.prepared.pipelineToken !== undefined) {
        pass.useRenderPipeline(input.prepared.pipelineToken);
      }
      const color = pass.colorAttachment(0, input.colorTarget, {
        load: 'clear',
        store: 'auto',
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      });
      input.publishColor?.(color);
      const depth =
        input.depthTarget !== undefined
          ? pass.depthStencilAttachment(input.depthTarget, {
              depthLoad: 'clear',
              depthStore: 'store',
              depthClearValue: 1.0
            })
          : undefined;
      if (depth !== undefined) input.publishDepth?.(depth);
      const uniform = pass.readBuffer(input.uniformBuffer, 'uniform');
      const skyTexture = pass.readTexture(input.skyTexture, 'sampled');
      return Object.freeze({ color, depth, uniform, skyTexture });
    },
    run(context: RasterPassContext, resources: BackgroundPassResources) {
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
      context.raster.setPipeline(pipeline);
      context.raster.setBindGroup(0, uniformGroup);
      context.raster.setBindGroup(1, textureGroup);
      context.raster.draw(3);
    }
  };
}

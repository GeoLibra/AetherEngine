import type {
  PassBuilder,
  RenderGraphBuilder,
  RenderSystemConditionContext,
  RenderSystemToken,
  RestrictedPassContext,
  TextureDescriptor,
  TextureHandle
} from '../../render-graph';
import type { BaselinePreparedFrame, BaselineRenderingOptions } from './types';

export function createPostColorContribution(
  graph: RenderGraphBuilder,
  prepared: Extract<BaselinePreparedFrame, { status: 'ready' }>,
  configuration: NonNullable<BaselineRenderingOptions['graphics']['surface']['configuration']>
) {
  const postColor = prepared.postColor!;
  const hdrTarget = graph.createTexture({
    width: configuration.width,
    height: configuration.height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'rgba16float',
    usage: ['color-attachment', 'sampled']
  });
  const uniform = graph.createBuffer(
    { size: postColor.uniformBuffer.size, usage: ['uniform'] },
    {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: `${prepared.view.id}:post-color` }
      }
    }
  );
  let source: TextureHandle | undefined;
  return {
    hdrTarget,
    uniform,
    prepared: postColor,
    publishSource(value: TextureHandle) {
      source = value;
    },
    descriptor(after: RenderSystemToken) {
      return {
        id: 'post-color',
        scope: 'per-view' as const,
        after: [after],
        runIf: ({ view }: RenderSystemConditionContext) => view?.id === prepared.view.id,
        setup(pass: PassBuilder) {
          if (source === undefined) throw new Error('Opaque HDR output was not published.');
          const sceneColor = pass.readTexture(source, 'sampled');
          const postUniform = pass.readBuffer(uniform, 'uniform');
          const surfaceTarget = pass.createTexture(
            attachment(
              configuration.width,
              configuration.height,
              configuration.format,
              'color-attachment'
            ),
            {
              origin: {
                kind: 'imported',
                initialState: 'undefined',
                acquire: { kind: 'external-acquire', id: prepared.view.surface }
              }
            }
          );
          const output = pass.writeTexture(surfaceTarget, 'color-attachment');
          pass.presentTexture(output, { kind: 'surface-frame', id: prepared.view.surface });
          return Object.freeze({ sceneColor, uniform: postUniform, output });
        },
        run(
          context: RestrictedPassContext,
          resources: {
            sceneColor: TextureHandle;
            uniform: import('../../render-graph').BufferHandle;
            output: TextureHandle;
          }
        ) {
          const textureGroup = context.device.createBindGroup({
            label: 'aether-post-color-texture',
            layout: context.bindGroupLayout(postColor.textureLayoutToken),
            entries: [
              { binding: 0, resource: context.texture(resources.sceneColor, 'sampled') },
              {
                binding: 1,
                resource: context.device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
              }
            ]
          });
          const uniformGroup = context.device.createBindGroup({
            label: 'aether-post-color-uniform',
            layout: context.bindGroupLayout(postColor.uniformLayoutToken),
            entries: [{ binding: 0, resource: context.buffer(resources.uniform, 'uniform') }]
          });
          const pipeline = context.renderPipeline(postColor.pipelineToken);
          const raster = context.beginRaster({
            label: 'post-color',
            colorAttachments: [
              {
                texture: resources.output,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
              }
            ]
          });
          raster.setViewport(0, 0, configuration.width, configuration.height, 0, 1);
          raster.setScissorRect(0, 0, configuration.width, configuration.height);
          raster.setPipeline(pipeline);
          raster.setBindGroup(0, textureGroup);
          raster.setBindGroup(1, uniformGroup);
          raster.draw(3);
          raster.end();
        }
      };
    }
  };
}

function attachment(
  width: number,
  height: number,
  format: TextureDescriptor['format'],
  usage: 'color-attachment' | 'depth-stencil-attachment'
): TextureDescriptor {
  return Object.freeze({
    width,
    height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format,
    usage: Object.freeze([usage])
  });
}

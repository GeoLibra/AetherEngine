import type {
  BufferHandle,
  RasterPassBuilder,
  RasterPassContext,
  TextureHandle
} from '../../render-graph';
import type { RasterRenderSystemDescriptor } from '../systems';
import { createPreparedToken } from '../../render-graph';
import type { OpaqueRenderSystemInput, OpaqueRenderSystemPreparation } from './types';
import { ReadonlyMapSnapshot } from '../world/readonly-collection-snapshot';

/**
 * Creates one per-view opaque RenderSystem that records prepared indexed draws.
 *
 * Pipeline compilation, material resolution, resource creation, queue submission, and ownership
 * retention remain outside the pass callback.
 *
 * @throws When the phase is not opaque or attachment descriptors are incompatible.
 */
export function createOpaqueRenderSystem(
  input: OpaqueRenderSystemInput
): OpaqueRenderSystemPreparation {
  validateInput(input);
  const bindings = new Map(
    input.phase.packets.map((packet, index) => [
      createPreparedToken('draw-resources', `${input.phase.viewId}:opaque:${index}`),
      packet
    ])
  );
  const entries = [...bindings];
  const descriptor: RasterRenderSystemDescriptor<unknown> = {
    kind: 'raster',
    id: input.id ?? 'opaque-draw',
    scope: 'per-view',
    runIf: ({ view }) => view?.id === input.phase.viewId,
    setup(pass: RasterPassBuilder) {
      for (const [token] of entries) pass.useDrawResources(token);
      const target =
        typeof input.colorTarget === 'function' ? input.colorTarget() : input.colorTarget;
      const surface =
        target ??
        pass.createTexture(input.color, {
          origin: {
            kind: 'imported',
            initialState: 'undefined',
            acquire: { kind: 'external-acquire', id: input.surfaceFrame.id }
          }
        });
      const depthTarget =
        typeof input.depthTarget === 'function' ? input.depthTarget() : input.depthTarget;
      const depth = depthTarget ?? pass.createTexture(input.depth);
      const color = pass.colorAttachment(0, surface, {
        load: input.colorLoadOp ?? 'clear',
        store: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      });
      const resolveTarget =
        typeof input.resolveTarget === 'function' ? input.resolveTarget() : input.resolveTarget;
      const resolved =
        resolveTarget === undefined
          ? color
          : (() => {
              if (pass.resolveAttachment === undefined) {
                throw new Error(
                  'RenderGraph raster pass does not support multisample resolve attachments.'
                );
              }
              return pass.resolveAttachment(0, color, resolveTarget);
            })();
      const depthAttachment = pass.depthStencilAttachment(depth, {
        depthLoad: input.depthLoadOp ?? 'clear',
        depthStore: 'store',
        depthClearValue: 1
      });
      input.publishColor?.(resolved);
      if (input.present !== false) pass.present(resolved, input.surfaceFrame);
      const lightList =
        input.lightList === undefined ? undefined : declareLightList(pass, input.lightList);
      const environment =
        input.environment === undefined
          ? undefined
          : Object.freeze({
              buffer: pass.readBuffer(input.environment.buffer, 'uniform'),
              irradianceMap: pass.readTexture(input.environment.irradianceMap, 'sampled'),
              prefilteredRadianceMap: pass.readTexture(
                input.environment.prefilteredRadianceMap,
                'sampled'
              ),
              environmentBrdfLut: pass.readTexture(input.environment.environmentBrdfLut, 'sampled')
            });
      const shadow =
        input.shadow === undefined
          ? undefined
          : Object.freeze({
              buffer: pass.readBuffer(input.shadow.buffer, 'uniform'),
              map: pass.readTexture(input.shadow.map, 'sampled'),
              localBuffer: pass.readBuffer(input.shadow.localBuffer, 'uniform')
            });
      return Object.freeze({
        color: resolved,
        depth: depthAttachment,
        lightList,
        environment,
        shadow
      });
    },
    run(context: RasterPassContext, resources) {
      const attachments = resources as {
        color: TextureHandle;
        depth: TextureHandle;
        lightList?: ReturnType<typeof declareLightList>;
        environment?: {
          buffer: BufferHandle;
          irradianceMap: TextureHandle;
          prefilteredRadianceMap: TextureHandle;
          environmentBrdfLut: TextureHandle;
        };
        shadow?: { buffer: BufferHandle; localBuffer: BufferHandle; map: TextureHandle };
      };
      const draws = entries.map(([token]) => context.drawResources(token));
      const lightListGroup =
        attachments.lightList === undefined || attachments.environment === undefined
          ? undefined
          : createLightListGroup(
              context,
              input.lightList!,
              attachments.lightList,
              attachments.environment,
              attachments.shadow
            );

      for (const draw of draws) {
        context.raster.setPipeline(draw.pipeline);
        draw.bindGroups.forEach((group, index) =>
          context.raster.setBindGroup(index, group, draw.dynamicOffsetsByGroup[index])
        );
        if (lightListGroup !== undefined) context.raster.setBindGroup(3, lightListGroup);
        draw.vertexBuffers.forEach((buffer, index) =>
          context.raster.setVertexBuffer(index, buffer)
        );
        context.raster.setIndexBuffer(draw.indexBuffer, draw.indexFormat);
        context.raster.drawIndexed(draw.indexCount, 1, draw.firstIndex);
      }
    }
  };
  return Object.freeze({
    preparedDrawResources: new ReadonlyMapSnapshot(bindings),
    descriptor
  });
}

function declareLightList(
  pass: RasterPassBuilder,
  input: NonNullable<OpaqueRenderSystemInput['lightList']>
) {
  if (input.source === 'gpu-compute') {
    return Object.freeze({
      source: input.source,
      packedLights: pass.readBuffer(input.packedLights, 'uniform'),
      directional: pass.readBuffer(input.output.directionalIndices, 'uniform'),
      headers: pass.readBuffer(input.output.headers, 'uniform'),
      indices: pass.readBuffer(input.output.lightIndices, 'uniform'),
      overflow: pass.readBuffer(input.output.overflow, 'uniform')
    });
  }
  if (input.source === 'gpu-cluster') {
    return Object.freeze({
      source: input.source,
      packedLights: pass.readBuffer(input.packedLights, 'uniform'),
      metadata: pass.readBuffer(input.metadata, 'uniform'),
      directional: pass.readBuffer(input.output.directional, 'uniform'),
      headers: pass.readBuffer(input.output.headers, 'uniform'),
      indices: pass.readBuffer(input.output.indices, 'uniform'),
      overflow: pass.readBuffer(input.output.overflow, 'uniform')
    });
  }
  return Object.freeze({
    source: input.source,
    packedLights: pass.readTexture(input.packedLights, 'sampled'),
    directional: pass.readTexture(input.output.directionalIndices, 'sampled'),
    headers: pass.readTexture(input.output.headers, 'sampled'),
    indices: pass.readTexture(input.output.lightIndices, 'sampled'),
    overflow: pass.readTexture(input.output.overflow, 'sampled')
  });
}

function createLightListGroup(
  context: RasterPassContext,
  input: NonNullable<OpaqueRenderSystemInput['lightList']>,
  resources: ReturnType<typeof declareLightList>,
  environment: {
    buffer: BufferHandle;
    irradianceMap: TextureHandle;
    prefilteredRadianceMap: TextureHandle;
    environmentBrdfLut: TextureHandle;
  },
  shadow?: { buffer: BufferHandle; localBuffer: BufferHandle; map: TextureHandle }
) {
  const layout = context.bindGroupLayout(input.bindGroupLayout);
  const handles = [
    resources.packedLights,
    resources.directional,
    resources.headers,
    resources.indices,
    resources.overflow
  ];
  return context.device.createBindGroup({
    label: 'standard-lit-light-list',
    layout,
    entries: [
      ...handles.map((handle, binding) => ({
        binding,
        resource:
          resources.source === 'gpu-compute' || resources.source === 'gpu-cluster'
            ? context.buffer(handle as BufferHandle, 'uniform')
            : context.texture(handle as TextureHandle, 'sampled')
      })),
      { binding: 5, resource: context.buffer(environment.buffer, 'uniform') },
      { binding: 6, resource: context.texture(environment.irradianceMap, 'sampled') },
      { binding: 7, resource: context.texture(environment.prefilteredRadianceMap, 'sampled') },
      { binding: 8, resource: context.texture(environment.environmentBrdfLut, 'sampled') },
      {
        binding: 9,
        resource: context.device.createSampler({
          minFilter: 'linear',
          magFilter: 'linear',
          mipmapFilter: 'linear',
          addressModeU: 'repeat',
          addressModeV: 'clamp-to-edge'
        })
      },
      ...(shadow === undefined
        ? []
        : [
            { binding: 10, resource: context.buffer(shadow.buffer, 'uniform') },
            { binding: 13, resource: context.buffer(shadow.localBuffer, 'uniform') },
            { binding: 11, resource: context.texture(shadow.map, 'sampled') },
            {
              binding: 12,
              resource: context.device.createSampler({
                compare: 'less-equal',
                minFilter: 'linear',
                magFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge'
              })
            }
          ]),
      ...(resources.source === 'gpu-cluster'
        ? [{ binding: 14, resource: context.buffer(resources.metadata, 'uniform') }]
        : [])
    ]
  });
}

function validateInput(input: OpaqueRenderSystemInput): void {
  if (input.phase.phase !== 'opaque' && input.phase.phase !== 'alpha-test')
    throw new Error('Opaque RenderSystem requires an opaque or alpha-test phase.');
  if (!input.color.usage.includes('color-attachment'))
    throw new Error('Opaque RenderSystem color output requires color-attachment usage.');
  if (!input.depth.usage.includes('depth-stencil-attachment'))
    throw new Error('Opaque RenderSystem depth output requires depth-stencil-attachment usage.');
  if (
    input.color.width !== input.depth.width ||
    input.color.height !== input.depth.height ||
    input.color.sampleCount !== input.depth.sampleCount
  )
    throw new Error('Opaque RenderSystem color and depth attachments must match.');
  if (input.resolveTarget !== undefined && input.color.sampleCount <= 1) {
    throw new Error('Opaque RenderSystem resolveTarget requires a multisampled color attachment.');
  }
}

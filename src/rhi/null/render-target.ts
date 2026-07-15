import { assertResourceLive, assertResourceOwnedBy, NullResourceBase } from './resource';
import type { NullDeviceOwner } from './resource';
import type {
  ColorAttachmentDescriptor,
  DepthStencilAttachmentDescriptor,
  RHIRenderPassColorAttachment,
  RHIRenderPassDepthStencilAttachment,
  RHIRenderPassDescriptor,
  RHIRenderTarget,
  RHITexture,
  RenderTargetDescriptor
} from '../contracts';

export class NullRenderTarget extends NullResourceBase implements RHIRenderTarget {
  readonly kind = 'render-target';
  readonly descriptor: Readonly<RenderTargetDescriptor>;

  constructor(
    id: number,
    owner: NullDeviceOwner,
    descriptor: RenderTargetDescriptor
  ) {
    super(id, owner, descriptor.label);
    validateRenderTargetDescriptor(descriptor, owner);
    this.descriptor = cloneRenderTargetDescriptor(descriptor);
  }

  createRenderPassDescriptor(): RHIRenderPassDescriptor {
    assertResourceLive(this);
    // ADR-001: RenderTarget stays as the RHI boundary for backend pass/framebuffer creation.
    const colorAttachments = this.descriptor.colorAttachments.map(
      (attachment): RHIRenderPassColorAttachment => {
        assertResourceLive(attachment.texture);
        const view = attachment.view ?? attachment.texture.createView({
          baseMipLevel: attachment.mipLevel ?? 0,
          baseArrayLayer: attachment.arrayLayer ?? 0
        });
        assertResourceLive(view);
        const passAttachment: RHIRenderPassColorAttachment = {
          view,
          loadOp: attachment.loadOp,
          storeOp: attachment.storeOp
        };
        if (attachment.clearValue !== undefined) {
          passAttachment.clearValue = attachment.clearValue;
        }
        if (attachment.resolveTarget !== undefined) {
          assertResourceLive(attachment.resolveTarget);
          passAttachment.resolveTarget = attachment.resolveTarget;
        }
        return passAttachment;
      }
    );
    const passDescriptor: RHIRenderPassDescriptor = { colorAttachments };
    if (this.descriptor.label !== undefined) {
      passDescriptor.label = this.descriptor.label;
    }
    if (this.descriptor.depthStencilAttachment !== undefined) {
      passDescriptor.depthStencilAttachment = createDepthStencilAttachment(
        this.descriptor.depthStencilAttachment
      );
    }
    return passDescriptor;
  }
}

function createDepthStencilAttachment(
  attachment: DepthStencilAttachmentDescriptor
): RHIRenderPassDepthStencilAttachment {
  assertResourceLive(attachment.texture);
  const view = attachment.view ?? attachment.texture.createView();
  assertResourceLive(view);
  const passAttachment: RHIRenderPassDepthStencilAttachment = { view };
  if (attachment.depthClearValue !== undefined) {
    passAttachment.depthClearValue = attachment.depthClearValue;
  }
  if (attachment.depthLoadOp !== undefined) {
    passAttachment.depthLoadOp = attachment.depthLoadOp;
  }
  if (attachment.depthStoreOp !== undefined) {
    passAttachment.depthStoreOp = attachment.depthStoreOp;
  }
  if (attachment.stencilClearValue !== undefined) {
    passAttachment.stencilClearValue = attachment.stencilClearValue;
  }
  if (attachment.stencilLoadOp !== undefined) {
    passAttachment.stencilLoadOp = attachment.stencilLoadOp;
  }
  if (attachment.stencilStoreOp !== undefined) {
    passAttachment.stencilStoreOp = attachment.stencilStoreOp;
  }
  return passAttachment;
}

function validateRenderTargetDescriptor(descriptor: RenderTargetDescriptor, owner: NullDeviceOwner): void {
  assertPositiveInteger(descriptor.width, 'Render target width');
  assertPositiveInteger(descriptor.height, 'Render target height');

  if (descriptor.colorAttachments.length === 0 && descriptor.depthStencilAttachment === undefined) {
    throw new Error('Render target requires at least one attachment.');
  }

  descriptor.colorAttachments.forEach((attachment, index) => {
    assertResourceOwnedBy(attachment.texture, owner);
    assertTextureMatchesTarget(attachment.texture, descriptor, `Color attachment ${index}`);
    assertTextureSampleCountMatches(attachment.texture, descriptor, `Color attachment ${index}`);
    assertResourceLive(attachment.texture);
    if (attachment.format !== attachment.texture.format) {
      throw new Error(
        `Color attachment ${index} format "${attachment.format}" does not match texture format "${attachment.texture.format}".`
      );
    }
    if (attachment.view !== undefined) {
      assertResourceOwnedBy(attachment.view, owner);
      assertAttachmentViewMatches(attachment.view, attachment.texture, attachment.format, descriptor, `Color attachment ${index}`);
    }
    if (attachment.resolveTarget !== undefined) {
      assertResourceOwnedBy(attachment.resolveTarget, owner);
      assertResourceLive(attachment.resolveTarget);
      if ((descriptor.sampleCount ?? 1) <= 1) {
        throw new Error(`Color attachment ${index} resolve target requires sampleCount greater than 1.`);
      }
      if (attachment.resolveTarget.format !== attachment.format) {
        throw new Error(
          `Color attachment ${index} resolve target format "${attachment.resolveTarget.format}" does not match attachment format "${attachment.format}".`
        );
      }
      assertTextureViewMatchesTarget(attachment.resolveTarget, descriptor, `Color attachment ${index} resolve target`);
    }
  });

  if (descriptor.depthStencilAttachment !== undefined) {
    assertResourceOwnedBy(descriptor.depthStencilAttachment.texture, owner);
    assertResourceLive(descriptor.depthStencilAttachment.texture);
    assertTextureSampleCountMatches(
      descriptor.depthStencilAttachment.texture,
      descriptor,
      'Depth-stencil attachment'
    );
    assertTextureMatchesTarget(
      descriptor.depthStencilAttachment.texture,
      descriptor,
      'Depth-stencil attachment'
    );
    if (descriptor.depthStencilAttachment.format !== descriptor.depthStencilAttachment.texture.format) {
      throw new Error(
        `Depth-stencil attachment format "${descriptor.depthStencilAttachment.format}" does not match texture format "${descriptor.depthStencilAttachment.texture.format}".`
      );
    }
    if (descriptor.depthStencilAttachment.view !== undefined) {
      assertResourceOwnedBy(descriptor.depthStencilAttachment.view, owner);
      assertAttachmentViewMatches(
        descriptor.depthStencilAttachment.view,
        descriptor.depthStencilAttachment.texture,
        descriptor.depthStencilAttachment.format,
        descriptor,
        'Depth-stencil attachment'
      );
    }
  }
}

function assertTextureSampleCountMatches(
  texture: RHITexture,
  descriptor: RenderTargetDescriptor,
  name: string
): void {
  const textureSampleCount = texture.descriptor.sampleCount ?? 1;
  const targetSampleCount = descriptor.sampleCount ?? 1;
  if (textureSampleCount !== targetSampleCount) {
    throw new Error(
      `${name} sampleCount ${textureSampleCount} does not match render target sampleCount ${targetSampleCount}.`
    );
  }
}

function assertTextureMatchesTarget(
  texture: RHITexture,
  descriptor: RenderTargetDescriptor,
  name: string
): void {
  if (texture.width !== descriptor.width || texture.height !== descriptor.height) {
    throw new Error(
      `${name} size ${texture.width}x${texture.height} does not match render target ${descriptor.width}x${descriptor.height}.`
    );
  }
}

function assertAttachmentViewMatches(
  view: NonNullable<ColorAttachmentDescriptor['view']>,
  texture: RHITexture,
  format: string,
  descriptor: RenderTargetDescriptor,
  name: string
): void {
  assertResourceLive(view);
  if (view.texture !== texture) {
    throw new Error(`${name} view does not belong to the attachment texture.`);
  }
  if (view.format !== format) {
    throw new Error(`${name} view format "${view.format}" does not match attachment format "${format}".`);
  }
  assertTextureViewMatchesTarget(view, descriptor, `${name} view`);
}

function assertTextureViewMatchesTarget(
  view: NonNullable<ColorAttachmentDescriptor['view']>,
  descriptor: RenderTargetDescriptor,
  name: string
): void {
  if (view.width !== descriptor.width || view.height !== descriptor.height) {
    throw new Error(
      `${name} size ${view.width}x${view.height} does not match render target ${descriptor.width}x${descriptor.height}.`
    );
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function cloneRenderTargetDescriptor(descriptor: RenderTargetDescriptor): RenderTargetDescriptor {
  const clone: RenderTargetDescriptor = {
    width: descriptor.width,
    height: descriptor.height,
    colorAttachments: descriptor.colorAttachments.map(cloneColorAttachment)
  };
  if (descriptor.label !== undefined) {
    clone.label = descriptor.label;
  }
  if (descriptor.depthOrArrayLayers !== undefined) {
    clone.depthOrArrayLayers = descriptor.depthOrArrayLayers;
  }
  if (descriptor.sampleCount !== undefined) {
    clone.sampleCount = descriptor.sampleCount;
  }
  if (descriptor.depthStencilAttachment !== undefined) {
    clone.depthStencilAttachment = { ...descriptor.depthStencilAttachment };
  }
  return clone;
}

function cloneColorAttachment(attachment: ColorAttachmentDescriptor): ColorAttachmentDescriptor {
  const clone: ColorAttachmentDescriptor = {
    texture: attachment.texture,
    format: attachment.format,
    loadOp: attachment.loadOp,
    storeOp: attachment.storeOp
  };
  if (attachment.view !== undefined) {
    clone.view = attachment.view;
  }
  if (attachment.mipLevel !== undefined) {
    clone.mipLevel = attachment.mipLevel;
  }
  if (attachment.arrayLayer !== undefined) {
    clone.arrayLayer = attachment.arrayLayer;
  }
  if (attachment.clearValue !== undefined) {
    clone.clearValue = attachment.clearValue;
  }
  if (attachment.resolveTarget !== undefined) {
    clone.resolveTarget = attachment.resolveTarget;
  }
  return clone;
}

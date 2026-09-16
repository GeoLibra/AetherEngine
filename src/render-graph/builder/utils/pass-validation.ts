import type { GraphPassDeclaration } from '../../types';

/**
 * Validates pass access rules at authoring/compile boundaries:
 *
 * - Raster attachment writes must only occur through declared attachments (colorAttachment, depthStencilAttachment, resolveAttachment).
 * - Compute writes must only declare storage-write.
 * - Copy writes must only declare copy-dst.
 */
export function validatePassAccessUsages(pass: GraphPassDeclaration): void {
  for (const access of pass.accesses) {
    if (access.kind === 'write') {
      switch (pass.passKind) {
        case 'raster': {
          if (access.handle.kind !== 'texture') {
            throw new Error(
              `Raster pass "${pass.id}" cannot declare buffer write access. Only texture attachment writes are allowed.`
            );
          }
          if (access.usage !== 'color-attachment' && access.usage !== 'depth-stencil-attachment') {
            throw new Error(
              `Raster pass "${pass.id}" cannot declare write usage "${access.usage}". Only attachment writes are allowed.`
            );
          }
          const details = pass.rasterDetails;
          const isColorAttachment = details?.colorAttachments.some(
            (att) =>
              att.output.resourceId === access.handle.resourceId &&
              att.output.version === access.handle.version
          );
          const isDepthAttachment =
            details?.depthStencilAttachment?.output !== undefined &&
            details.depthStencilAttachment.output.resourceId === access.handle.resourceId &&
            details.depthStencilAttachment.output.version === access.handle.version;
          const isResolveAttachment = details?.resolveAttachments.some(
            (att) =>
              att.output.resourceId === access.handle.resourceId &&
              att.output.version === access.handle.version
          );
          if (!isColorAttachment && !isDepthAttachment && !isResolveAttachment) {
            throw new Error(
              `Raster pass "${pass.id}" texture write must be declared through colorAttachment, depthStencilAttachment, or resolveAttachment.`
            );
          }
          break;
        }
        case 'compute': {
          if (access.usage !== 'storage-write') {
            throw new Error(
              `Compute pass "${pass.id}" cannot declare write usage "${access.usage}". Only "storage-write" is allowed.`
            );
          }
          break;
        }
        case 'copy': {
          if (access.usage !== 'copy-dst') {
            throw new Error(
              `Copy pass "${pass.id}" cannot declare write usage "${access.usage}". Only "copy-dst" is allowed.`
            );
          }
          break;
        }
        default: {
          const exhaustiveCheck: never = pass.passKind;
          throw new Error(`Unsupported pass kind: ${(exhaustiveCheck as any)?.passKind}`);
        }
      }
    }
  }
}

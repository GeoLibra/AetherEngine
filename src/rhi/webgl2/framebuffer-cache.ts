import type { RHIResource, RHITextureView } from '../contracts/resource';
import { createFramebufferCacheKey } from './cache-key';
import type { WebGL2RenderPassSnapshot } from './command-types';
import type { WebGL2Metrics } from './metrics';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './native-types';
import { getWebGL2Handle } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';

interface FramebufferEntry {
  readonly handle: WebGL2NativeObject;
  readonly dependencies: ReadonlySet<number>;
}

export class WebGL2FramebufferCache {
  private readonly entries = new Map<string, FramebufferEntry>();

  constructor(
    private readonly owner: WebGL2DeviceOwner,
    private readonly native: WebGL2NativeContextPort,
    private readonly metrics: WebGL2Metrics
  ) { owner.subscribeResourceRelease((resource) => this.evictResource(resource.id)); }

  getOrCreate(descriptor: WebGL2RenderPassSnapshot): WebGL2NativeObject {
    const key = createFramebufferCacheKey(descriptor, this.owner.generation);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.metrics.recordFramebufferCacheHit();
      return cached.handle;
    }
    this.metrics.recordFramebufferCacheMiss();
    const lowered = this.lowerDescriptor(descriptor);
    const create = required(this.native.createFramebuffer, 'createFramebuffer');
    const handle = create.call(this.native, lowered);
    this.metrics.recordGLCall();
    const check = required(this.native.checkFramebufferStatus, 'checkFramebufferStatus');
    const status = check.call(this.native, handle);
    this.metrics.recordGLCall();
    if (!status.complete) {
      this.native.deleteFramebuffer?.(handle);
      if (this.native.deleteFramebuffer !== undefined) this.metrics.recordGLCall();
      throw new Error(`WebGL2 framebuffer is incomplete (${status.status ?? 'unknown'}): ${describeAttachments(descriptor)}.`);
    }
    this.entries.set(key, { handle, dependencies: collectDependencies(descriptor) });
    return handle;
  }

  lowerDescriptor(descriptor: WebGL2RenderPassSnapshot): Readonly<Record<string, unknown>> {
    return Object.freeze({
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      colorAttachments: Object.freeze(descriptor.colorAttachments.map((attachment) => Object.freeze({
        ...attachment,
        view: getWebGL2Handle(attachment.view, this.owner),
        ...(attachment.resolveTarget === undefined ? {} : {
          resolveTarget: getWebGL2Handle(attachment.resolveTarget, this.owner)
        })
      }))),
      ...(descriptor.depthStencilAttachment === undefined ? {} : {
        depthStencilAttachment: Object.freeze({
          ...descriptor.depthStencilAttachment,
          view: getWebGL2Handle(descriptor.depthStencilAttachment.view, this.owner)
        })
      })
    });
  }

  clear(): void {
    for (const entry of this.entries.values()) this.delete(entry.handle);
    this.entries.clear();
  }

  abandon(): void {
    this.entries.clear();
  }

  private evictResource(resourceId: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (!entry.dependencies.has(resourceId)) continue;
      this.entries.delete(key);
      this.delete(entry.handle);
    }
  }

  private delete(handle: WebGL2NativeObject): void {
    this.native.deleteFramebuffer?.(handle);
    if (this.native.deleteFramebuffer !== undefined) this.metrics.recordGLCall();
  }
}

function collectDependencies(descriptor: WebGL2RenderPassSnapshot): ReadonlySet<number> {
  const ids = new Set<number>();
  const add = (view: RHITextureView) => { ids.add(view.id); ids.add(view.texture.id); };
  for (const attachment of descriptor.colorAttachments) {
    add(attachment.view);
    if (attachment.resolveTarget !== undefined) add(attachment.resolveTarget);
  }
  if (descriptor.depthStencilAttachment !== undefined) add(descriptor.depthStencilAttachment.view);
  return ids;
}

function describeAttachments(descriptor: WebGL2RenderPassSnapshot): string {
  const describe = (view: RHIResource & { readonly format: string }) =>
    `"${view.label ?? view.id}" format=${view.format}`;
  const colors = descriptor.colorAttachments.map((attachment, index) =>
    `color[${index}]=${describe(attachment.view)}`
  );
  if (descriptor.depthStencilAttachment !== undefined) {
    colors.push(`depthStencil=${describe(descriptor.depthStencilAttachment.view)}`);
  }
  return colors.join(', ');
}

function required<T extends (...args: never[]) => unknown>(operation: T | undefined, name: string): T {
  if (operation === undefined) throw new Error(`Native WebGL2 context does not support ${name}.`);
  return operation;
}

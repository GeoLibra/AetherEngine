import type { RHIRenderPipeline } from '../contracts/resource';
import {
  createVertexArrayCacheKey,
  type WebGL2IndexBufferState,
  type WebGL2VertexBufferState
} from './cache-key';
import type { WebGL2Metrics } from './metrics';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './native-types';
import { getWebGL2Handle } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';

interface VertexArrayEntry {
  readonly handle: WebGL2NativeObject;
  readonly dependencies: ReadonlySet<number>;
}

export class WebGL2VertexArrayCache {
  private readonly entries = new Map<string, VertexArrayEntry>();

  constructor(
    private readonly owner: WebGL2DeviceOwner,
    private readonly native: WebGL2NativeContextPort,
    private readonly metrics: WebGL2Metrics
  ) { owner.subscribeResourceRelease((resource) => this.evictResource(resource.id)); }

  getOrCreate(
    pipeline: RHIRenderPipeline,
    vertexBuffers: ReadonlyMap<number, WebGL2VertexBufferState>,
    indexBuffer: WebGL2IndexBufferState | undefined
  ): WebGL2NativeObject {
    const key = createVertexArrayCacheKey(pipeline, vertexBuffers, indexBuffer);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.metrics.recordVertexArrayCacheHit();
      return cached.handle;
    }
    this.metrics.recordVertexArrayCacheMiss();
    const create = this.native.createVertexArray;
    if (create === undefined) throw new Error('Native WebGL2 context does not support createVertexArray.');
    const handle = create.call(this.native, Object.freeze({
      vertexLayout: pipeline.descriptor.vertex?.buffers ?? [],
      vertexBuffers: Object.freeze([...vertexBuffers.entries()].map(([slot, state]) => Object.freeze({
        slot,
        buffer: getWebGL2Handle(state.buffer, this.owner),
        offset: state.offset,
        ...(state.size === undefined ? {} : { size: state.size })
      }))),
      ...(indexBuffer === undefined ? {} : { indexBuffer: Object.freeze({
        buffer: getWebGL2Handle(indexBuffer.buffer, this.owner),
        offset: indexBuffer.offset,
        format: indexBuffer.format,
        ...(indexBuffer.size === undefined ? {} : { size: indexBuffer.size })
      }) })
    }));
    this.metrics.recordGLCall();
    const dependencies = new Set<number>([pipeline.id]);
    for (const state of vertexBuffers.values()) dependencies.add(state.buffer.id);
    if (indexBuffer !== undefined) dependencies.add(indexBuffer.buffer.id);
    this.entries.set(key, { handle, dependencies });
    return handle;
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
    this.native.deleteVertexArray?.(handle);
    if (this.native.deleteVertexArray !== undefined) this.metrics.recordGLCall();
  }
}

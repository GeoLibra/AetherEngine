import type { BufferUsage, GraphPassDeclaration, TextureUsage } from '../../types';

export class GroupUsageAccumulator {
  private readonly textureUsages = new Map<number, Set<TextureUsage>>();
  private readonly bufferUsages = new Map<number, Set<BufferUsage>>();

  clone(): GroupUsageAccumulator {
    const copy = new GroupUsageAccumulator();
    for (const [id, set] of this.textureUsages) {
      copy.textureUsages.set(id, new Set(set));
    }
    for (const [id, set] of this.bufferUsages) {
      copy.bufferUsages.set(id, new Set(set));
    }
    return copy;
  }

  addPass(pass: GraphPassDeclaration): void {
    for (const access of pass.accesses) {
      if (access.handle.kind === 'texture') {
        let set = this.textureUsages.get(access.handle.resourceId);
        if (set === undefined) {
          set = new Set();
          this.textureUsages.set(access.handle.resourceId, set);
        }
        set.add(access.usage as TextureUsage);
      } else if (access.handle.kind === 'buffer') {
        let set = this.bufferUsages.get(access.handle.resourceId);
        if (set === undefined) {
          set = new Set();
          this.bufferUsages.set(access.handle.resourceId, set);
        }
        set.add(access.usage as BufferUsage);
      }
    }
  }

  /** Checks whether merging candidate's usages into this group causes a usage-scope conflict. */
  hasUsageConflictWith(candidate: GraphPassDeclaration): boolean {
    const candidateTextures = new Map<number, Set<TextureUsage>>();
    const candidateBuffers = new Map<number, Set<BufferUsage>>();

    for (const access of candidate.accesses) {
      if (access.handle.kind === 'texture') {
        let set = candidateTextures.get(access.handle.resourceId);
        if (set === undefined) {
          set = new Set();
          candidateTextures.set(access.handle.resourceId, set);
        }
        set.add(access.usage as TextureUsage);
      } else if (access.handle.kind === 'buffer') {
        let set = candidateBuffers.get(access.handle.resourceId);
        if (set === undefined) {
          set = new Set();
          candidateBuffers.set(access.handle.resourceId, set);
        }
        set.add(access.usage as BufferUsage);
      }
    }

    // Check textures
    for (const [id, candSet] of candidateTextures) {
      const existing = this.textureUsages.get(id);
      if (existing === undefined) continue;

      const combined = new Set([...existing, ...candSet]);
      const hasAttachment =
        combined.has('color-attachment') || combined.has('depth-stencil-attachment');
      const hasSampledOrStorage =
        combined.has('sampled') ||
        combined.has('storage-read') ||
        combined.has('storage-write') ||
        combined.has('copy-src') ||
        combined.has('copy-dst');

      // A texture cannot be both an attachment and sampled/storage within the same physical render pass
      if (hasAttachment && hasSampledOrStorage) {
        return true;
      }
    }

    // Check buffers
    for (const [id, candSet] of candidateBuffers) {
      const existing = this.bufferUsages.get(id);
      if (existing === undefined) continue;

      const combined = new Set([...existing, ...candSet]);
      const hasWrite = combined.has('storage-write') || combined.has('copy-dst');
      const hasRead =
        combined.has('vertex') ||
        combined.has('index') ||
        combined.has('uniform') ||
        combined.has('storage-read') ||
        combined.has('indirect');

      // Inter-pass buffer write-after-read or read-after-write requires a boundary without explicit barriers
      if (hasWrite && hasRead) {
        return true;
      }
    }

    return false;
  }

  freeze(): {
    textures: ReadonlyMap<number, readonly TextureUsage[]>;
    buffers: ReadonlyMap<number, readonly BufferUsage[]>;
  } {
    const textures = new Map<number, readonly TextureUsage[]>();
    for (const [id, set] of this.textureUsages) {
      textures.set(id, Object.freeze([...set]));
    }
    const buffers = new Map<number, readonly BufferUsage[]>();
    for (const [id, set] of this.bufferUsages) {
      buffers.set(id, Object.freeze([...set]));
    }
    return {
      textures,
      buffers
    };
  }
}

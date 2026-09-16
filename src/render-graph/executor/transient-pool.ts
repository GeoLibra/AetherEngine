import type {
  RHIBuffer,
  RHIDevice,
  RHIResource,
  RHISubmission,
  RHITexture,
  SubmissionResult
} from '../../rhi/contracts';
import type {
  SurfaceTransientScope,
  TransientAllocationDescriptor,
  TransientResource,
  TransientResourcePoolCounters
} from '../types';

interface PoolEntry {
  readonly key: string;
  readonly resource: TransientResource;
  readonly submissions: Set<number>;
  readonly surfaceScope: SurfaceTransientScope | undefined;
  released: boolean;
  failed: boolean;
  retired: boolean;
  discarded: boolean;
}

/** Reuses only completed physical allocations with an identical portable descriptor. */
export class TransientResourcePool {
  private readonly reusable = new Map<string, PoolEntry[]>();
  private readonly entries = new Map<RHIResource, PoolEntry>();
  private readonly surfaceTargetIds = new Map<symbol, number>();
  private readonly surfaceGenerationFloors = new Map<symbol, number>();
  private nextSurfaceTargetId = 1;
  private disposedAllocationCount = 0;

  constructor(private readonly device: RHIDevice) {
    void device.lost.then(() => this.dispose());
  }

  /** Returns an immutable diagnostic snapshot without changing allocation state. */
  get counters(): TransientResourcePoolCounters {
    let activeAllocations = 0;
    let reusableAllocations = 0;
    let retiringAllocations = 0;
    for (const entry of this.entries.values()) {
      if (entry.retired || entry.submissions.size > 0) retiringAllocations++;
      else if (entry.released) reusableAllocations++;
      else activeAllocations++;
    }
    return Object.freeze({
      activeAllocations,
      reusableAllocations,
      retiringAllocations,
      disposedAllocations: this.disposedAllocationCount
    });
  }

  acquire(descriptor: TransientAllocationDescriptor): TransientResource {
    const requestedScope = descriptor.kind === 'texture' ? descriptor.surfaceScope : undefined;
    if (requestedScope !== undefined) this.validateSurfaceScope(requestedScope);
    const surfaceScope =
      requestedScope === undefined ? undefined : Object.freeze({ ...requestedScope });
    const key = this.descriptorKey(descriptor, surfaceScope);
    const reusable = this.reusable.get(key);
    const entry = reusable?.pop();
    if (entry !== undefined) {
      entry.released = false;
      return entry.resource;
    }

    const resource = createResource(this.device, descriptor);
    this.entries.set(resource, {
      key,
      resource,
      submissions: new Set(),
      surfaceScope,
      released: false,
      failed: false,
      retired: false,
      discarded: false
    });
    return resource;
  }

  retain(resource: TransientResource, submission: RHISubmission): void {
    const entry = this.requiredEntry(resource);
    if (entry.released) throw new Error('Cannot retain a released transient allocation.');
    if (entry.submissions.has(submission.id)) return;
    entry.submissions.add(submission.id);
    void submission.done.then(
      (result) => this.settle(entry, submission.id, result),
      () => this.settle(entry, submission.id, { status: 'failed' })
    );
  }

  release(
    resource: TransientResource,
    submissions: RHISubmission | readonly RHISubmission[] | undefined = undefined
  ): void {
    const entry = this.requiredEntry(resource);
    if (entry.released) throw new Error('Transient allocation has already been released.');
    for (const submission of normalizeSubmissions(submissions)) this.retain(resource, submission);
    entry.released = true;
    if (entry.submissions.size === 0) this.finish(entry);
  }

  /**
   * Prevents obsolete generations for one surface target from returning to the reusable pool.
   * Resources retained by pending submissions remain live until those submissions become terminal.
   */
  retireSurfaceScopesBefore(targetId: symbol, generation: number): void {
    validateSurfaceGeneration(generation);
    const previousFloor = this.surfaceGenerationFloors.get(targetId) ?? 0;
    const floor = Math.max(previousFloor, generation);
    this.surfaceGenerationFloors.set(targetId, floor);
    for (const entry of this.entries.values()) {
      const scope = entry.surfaceScope;
      if (scope === undefined || scope.targetId !== targetId || scope.generation >= floor) continue;
      entry.retired = true;
      this.removeReusableEntry(entry);
      if (entry.released && entry.submissions.size === 0) this.disposeEntry(entry);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.discarded = true;
      if (entry.submissions.size === 0) this.disposeEntry(entry);
    }
    this.reusable.clear();
  }

  private settle(entry: PoolEntry, submissionId: number, result: SubmissionResult): void {
    if (!entry.submissions.delete(submissionId)) return;
    if (result.status !== 'completed') entry.failed = true;
    if (entry.submissions.size === 0 && (entry.released || entry.discarded)) this.finish(entry);
  }

  private finish(entry: PoolEntry): void {
    if (
      entry.discarded ||
      entry.retired ||
      entry.failed ||
      this.device.state !== 'live' ||
      entry.resource.state !== 'live'
    ) {
      this.disposeEntry(entry);
      return;
    }
    const reusable = this.reusable.get(entry.key) ?? [];
    reusable.push(entry);
    this.reusable.set(entry.key, reusable);
  }

  private disposeEntry(entry: PoolEntry): void {
    if (!this.entries.has(entry.resource)) return;
    entry.discarded = true;
    this.removeReusableEntry(entry);
    this.entries.delete(entry.resource);
    entry.resource.dispose();
    this.disposedAllocationCount++;
  }

  private removeReusableEntry(entry: PoolEntry): void {
    const reusable = this.reusable.get(entry.key);
    if (reusable === undefined) return;
    const index = reusable.indexOf(entry);
    if (index >= 0) reusable.splice(index, 1);
    if (reusable.length === 0) this.reusable.delete(entry.key);
  }

  private validateSurfaceScope(scope: SurfaceTransientScope): void {
    validateSurfaceGeneration(scope.generation);
    validateSurfaceExtent(scope.width, 'width');
    validateSurfaceExtent(scope.height, 'height');
    const floor = this.surfaceGenerationFloors.get(scope.targetId) ?? 0;
    if (scope.generation < floor) {
      throw new Error(
        `Cannot acquire a transient texture for obsolete surface generation ${scope.generation}; current generation is ${floor}.`
      );
    }
  }

  private descriptorKey(
    descriptor: TransientAllocationDescriptor,
    surfaceScope: SurfaceTransientScope | undefined
  ): string {
    const base = `${descriptor.kind}:${stableValue(descriptor.descriptor, new Set(['label']))}`;
    if (descriptor.kind === 'buffer' || surfaceScope === undefined) return base;
    const scope = surfaceScope;
    let targetId = this.surfaceTargetIds.get(scope.targetId);
    if (targetId === undefined) {
      targetId = this.nextSurfaceTargetId++;
      this.surfaceTargetIds.set(scope.targetId, targetId);
    }
    return `${base}:surface:${targetId}:${scope.generation}:${scope.width}x${scope.height}`;
  }

  private requiredEntry(resource: TransientResource): PoolEntry {
    const entry = this.entries.get(resource);
    if (entry === undefined) throw new Error('Transient allocation does not belong to this pool.');
    if (entry.discarded) throw new Error('Transient allocation has been discarded.');
    return entry;
  }
}

function createResource(
  device: RHIDevice,
  descriptor: TransientAllocationDescriptor
): TransientResource {
  return descriptor.kind === 'buffer'
    ? device.createBuffer(descriptor.descriptor)
    : device.createTexture(descriptor.descriptor);
}

function normalizeSubmissions(
  submissions: RHISubmission | readonly RHISubmission[] | undefined
): readonly RHISubmission[] {
  if (submissions === undefined) return [];
  return Array.isArray(submissions) ? submissions : [submissions as RHISubmission];
}

function stableValue(value: unknown, omitted: ReadonlySet<string> = new Set()): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableValue(item, omitted)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => !omitted.has(key))
      .sort()
      .map((key) => `${key}:${stableValue(record[key], omitted)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateSurfaceGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Surface transient generation must be a positive safe integer.');
  }
}

function validateSurfaceExtent(value: number, name: 'width' | 'height'): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Surface transient ${name} must be a positive safe integer.`);
  }
}

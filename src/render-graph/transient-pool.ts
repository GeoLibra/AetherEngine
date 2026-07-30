import type {
  RHIBuffer,
  RHIDevice,
  RHIResource,
  RHISubmission,
  RHITexture,
  GPUBufferDescriptor,
  GPUTextureDescriptor,
  SubmissionResult
} from '../rhi/contracts';

export type TransientAllocationDescriptor =
  | { readonly kind: 'buffer'; readonly descriptor: GPUBufferDescriptor }
  | { readonly kind: 'texture'; readonly descriptor: GPUTextureDescriptor };

export type TransientResource = RHIBuffer | RHITexture;

interface PoolEntry {
  readonly key: string;
  readonly resource: TransientResource;
  readonly submissions: Set<number>;
  released: boolean;
  failed: boolean;
  discarded: boolean;
}

/** Reuses only completed physical allocations with an identical portable descriptor. */
export class TransientResourcePool {
  private readonly reusable = new Map<string, PoolEntry[]>();
  private readonly entries = new Map<RHIResource, PoolEntry>();

  constructor(private readonly device: RHIDevice) {
    void device.lost.then(() => this.dispose());
  }

  acquire(descriptor: TransientAllocationDescriptor): TransientResource {
    const key = descriptorKey(descriptor);
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
      released: false,
      failed: false,
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

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.discarded = true;
      if (!entry.released || entry.submissions.size === 0) this.disposeEntry(entry);
    }
    this.reusable.clear();
  }

  private settle(entry: PoolEntry, submissionId: number, result: SubmissionResult): void {
    if (!entry.submissions.delete(submissionId)) return;
    if (result.status !== 'completed') entry.failed = true;
    if (entry.released && entry.submissions.size === 0) this.finish(entry);
  }

  private finish(entry: PoolEntry): void {
    if (
      entry.discarded ||
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
    entry.discarded = true;
    entry.resource.dispose();
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

function descriptorKey(descriptor: TransientAllocationDescriptor): string {
  return `${descriptor.kind}:${stableValue(descriptor.descriptor, new Set(['label']))}`;
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

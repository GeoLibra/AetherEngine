import type {
  RHIBuffer,
  RHIDevice,
  RHISubmission,
  RHITexture,
  SubmissionResult
} from '../rhi/contracts';
import type { TransientAllocationDescriptor, TransientResource } from './transient-pool';

export type HistoryInvalidationReason =
  | 'new'
  | 'generation-changed'
  | 'resize'
  | 'abi-changed'
  | 'policy-changed'
  | 'explicit-reset'
  | 'view-destroyed'
  | 'submission-failed'
  | 'device-lost';

export interface HistoryIdentity {
  readonly deviceGeneration: number;
  readonly viewId?: string;
  readonly sharedScope?: string;
  readonly key: string;
  readonly descriptor: TransientAllocationDescriptor;
  readonly slots: number;
  readonly abi?: string;
  readonly policy?: string;
}

export interface AcquiredHistorySlot {
  readonly handle: TransientResource;
  readonly valid: boolean;
  readonly slot: number;
  readonly invalidationReason: HistoryInvalidationReason | undefined;
}

interface HistorySlot {
  readonly handle: TransientResource;
  pendingSubmissionId: number | undefined;
  valid: boolean;
  invalidationReason: HistoryInvalidationReason | undefined;
  retired: boolean;
}

interface HistoryRecord {
  readonly identity: HistoryIdentity;
  readonly configuration: string;
  readonly slots: HistorySlot[];
  nextSlot: number;
  retired: boolean;
}

/** Owns non-aliasable history slots and invalidates them at explicit frame boundaries. */
export class HistoryRegistry {
  private readonly records = new Map<string, HistoryRecord>();
  private readonly nextInvalidation = new Map<string, HistoryInvalidationReason>();

  constructor(private readonly device: RHIDevice) {
    void device.lost.then(() => this.invalidateAll('device-lost'));
  }

  acquire(identity: HistoryIdentity): AcquiredHistorySlot {
    validateIdentity(identity);
    const key = identityKey(identity);
    let record = this.records.get(key);
    const configuration = configurationKey(identity);
    if (record === undefined) {
      record = this.createRecord(identity, this.nextInvalidation.get(key) ?? 'new');
      this.nextInvalidation.delete(key);
      this.records.set(key, record);
    } else if (record.configuration !== configuration) {
      if (identity.sharedScope !== undefined) {
        throw new Error(
          'Shared history scope has incompatible descriptor, ABI, policy, or generation.'
        );
      }
      const reason = changedReason(record.identity, identity);
      this.retireRecord(record);
      record = this.createRecord(identity, reason);
      this.records.set(key, record);
    }

    const slot = writableSlot(record);
    if (slot === undefined) throw new Error(`History "${identity.key}" has no writable slots.`);
    return Object.freeze({
      handle: slot.handle,
      valid: slot.valid,
      slot: record.slots.indexOf(slot),
      invalidationReason: slot.valid ? undefined : slot.invalidationReason
    });
  }

  publish(identity: HistoryIdentity, slotIndex: number, submission: RHISubmission): void {
    const record = this.requiredRecord(identity);
    const slot = record.slots[slotIndex];
    if (slot === undefined) throw new Error(`History slot ${slotIndex} does not exist.`);
    if (slot.pendingSubmissionId !== undefined)
      throw new Error(`History slot ${slotIndex} is still pending.`);

    slot.pendingSubmissionId = submission.id;
    record.nextSlot = (slotIndex + 1) % record.slots.length;
    void submission.done.then(
      (result) => this.settle(record, slot, submission.id, result),
      () => this.settle(record, slot, submission.id, { status: 'failed' })
    );
  }

  invalidate(
    identity: HistoryIdentity,
    reason: HistoryInvalidationReason = 'explicit-reset'
  ): void {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined) return;
    if (record.configuration !== configurationKey(identity)) {
      throw new Error('History identity does not match the active resource configuration.');
    }
    this.retireRecord(record);
    this.records.delete(key);
    this.nextInvalidation.set(key, reason);
  }

  reset(identity: HistoryIdentity): void {
    this.invalidate(identity);
  }

  invalidateView(viewId: string): void {
    for (const [key, record] of this.records) {
      if (record.identity.sharedScope === undefined && record.identity.viewId === viewId) {
        this.retireRecord(record);
        this.records.delete(key);
        this.nextInvalidation.set(key, 'view-destroyed');
      }
    }
  }

  private createRecord(
    identity: HistoryIdentity,
    reason: HistoryInvalidationReason
  ): HistoryRecord {
    return {
      identity,
      configuration: configurationKey(identity),
      slots: Array.from({ length: identity.slots }, () => ({
        handle: createResource(this.device, identity.descriptor),
        pendingSubmissionId: undefined,
        valid: false,
        invalidationReason: reason,
        retired: false
      })),
      nextSlot: 0,
      retired: false
    };
  }

  private requiredRecord(identity: HistoryIdentity): HistoryRecord {
    const record = this.records.get(identityKey(identity));
    if (record === undefined || record.configuration !== configurationKey(identity)) {
      throw new Error('History identity is not currently acquired.');
    }
    return record;
  }

  private settle(
    record: HistoryRecord,
    slot: HistorySlot,
    submissionId: number,
    result: SubmissionResult
  ): void {
    if (slot.pendingSubmissionId !== submissionId) return;
    slot.pendingSubmissionId = undefined;
    if (result.status === 'completed' && !record.retired) {
      slot.valid = true;
      slot.invalidationReason = undefined;
    } else {
      slot.valid = false;
      slot.invalidationReason =
        result.status === 'device-lost' ? 'device-lost' : 'submission-failed';
    }
    if (slot.retired) slot.handle.dispose();
  }

  private retireRecord(record: HistoryRecord): void {
    if (record.retired) return;
    record.retired = true;
    for (const slot of record.slots) {
      slot.retired = true;
      slot.valid = false;
      if (slot.pendingSubmissionId === undefined) slot.handle.dispose();
    }
  }

  private invalidateAll(reason: HistoryInvalidationReason): void {
    for (const [key, record] of this.records) {
      this.retireRecord(record);
      this.records.delete(key);
      this.nextInvalidation.set(key, reason);
    }
  }
}

function writableSlot(record: HistoryRecord): HistorySlot | undefined {
  for (let offset = 0; offset < record.slots.length; offset += 1) {
    const index = (record.nextSlot + offset) % record.slots.length;
    const slot = record.slots[index];
    if (slot !== undefined && !slot.retired && slot.pendingSubmissionId === undefined) return slot;
  }
  return undefined;
}

function createResource(
  device: RHIDevice,
  descriptor: TransientAllocationDescriptor
): TransientResource {
  return descriptor.kind === 'buffer'
    ? (device.createBuffer(descriptor.descriptor) as RHIBuffer)
    : (device.createTexture(descriptor.descriptor) as RHITexture);
}

function validateIdentity(identity: HistoryIdentity): void {
  if (!Number.isSafeInteger(identity.deviceGeneration) || identity.deviceGeneration < 0) {
    throw new Error('History device generation must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(identity.slots) || identity.slots < 1) {
    throw new Error('History slot count must be a positive integer.');
  }
  if (identity.key.length === 0) throw new Error('History key must not be empty.');
  if (
    identity.sharedScope === undefined &&
    (identity.viewId === undefined || identity.viewId.length === 0)
  ) {
    throw new Error('History identity requires a viewId or an explicit sharedScope.');
  }
}

function identityKey(identity: HistoryIdentity): string {
  const scope =
    identity.sharedScope === undefined
      ? `view:${identity.viewId}`
      : `shared:${identity.sharedScope}`;
  return `${scope}:key:${identity.key}`;
}

function configurationKey(identity: HistoryIdentity): string {
  return stableValue({
    deviceGeneration: identity.deviceGeneration,
    descriptor: identity.descriptor,
    slots: identity.slots,
    abi: identity.abi,
    policy: identity.policy
  });
}

function changedReason(
  previous: HistoryIdentity,
  next: HistoryIdentity
): HistoryInvalidationReason {
  if (previous.deviceGeneration !== next.deviceGeneration) return 'generation-changed';
  if (extentKey(previous.descriptor) !== extentKey(next.descriptor)) return 'resize';
  if (previous.policy !== next.policy) return 'policy-changed';
  return 'abi-changed';
}

function extentKey(descriptor: TransientAllocationDescriptor): string {
  if (descriptor.kind === 'buffer') return String(descriptor.descriptor.size);
  const size = descriptor.descriptor.size;
  if (typeof size === 'number') return `${size}:1:1`;
  if (isExtentArray(size)) return `${size[0] ?? 1}:${size[1] ?? 1}:${size[2] ?? 1}`;
  const objectSize = size as { width: number; height?: number; depthOrArrayLayers?: number };
  return `${objectSize.width}:${objectSize.height ?? 1}:${objectSize.depthOrArrayLayers ?? 1}`;
}

function isExtentArray(value: unknown): value is readonly number[] {
  return Array.isArray(value);
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => key !== 'label')
      .sort()
      .map((key) => `${key}:${stableValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

import type {
  RHIBuffer,
  RHIDevice,
  RHISubmission,
  RHITexture,
  SubmissionResult
} from '../rhi/contracts';
import type { TransientAllocationDescriptor, TransientResource } from './transient-pool';
import type { FeaturePolicyCacheInvalidation } from '../feature-policy/types';

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

export interface HistoryReadableSlot {
  readonly handle: TransientResource;
  readonly slot: number;
  readonly valid: true;
  readonly invalidationReason: undefined;
}

export interface HistoryWritableSlot {
  readonly handle: TransientResource;
  readonly slot: number;
  readonly valid: false;
  readonly invalidationReason: HistoryInvalidationReason | undefined;
}

/** One frame's explicit previous-content input and distinct reserved next-content output. */
export interface AcquiredHistorySlot {
  readonly readable: HistoryReadableSlot | undefined;
  readonly writable: HistoryWritableSlot;
  /** Opaque registry-owned reservation identity used to reject stale execution bindings. */
  readonly reservationId: number;
}

export interface HistorySlotDebugState {
  readonly slot: number;
  readonly valid: boolean;
  readonly invalidationReason: HistoryInvalidationReason | undefined;
  readonly producerSubmissionId: number | undefined;
  readonly pendingSubmissionIds: readonly number[];
  readonly pendingRetirement: boolean;
}

interface HistorySlot {
  readonly handle: TransientResource;
  readonly retainingSubmissionIds: Set<number>;
  producerSubmissionId: number | undefined;
  valid: boolean;
  invalidationReason: HistoryInvalidationReason | undefined;
  publicationOrder: number;
  reservationId: number | undefined;
  retired: boolean;
}

interface HistoryRecord {
  readonly identity: HistoryIdentity;
  readonly configuration: string;
  readonly slots: HistorySlot[];
  nextSlot: number;
  nextPublicationOrder: number;
  activeReservationId: number | undefined;
  retired: boolean;
}

/** Owns non-aliasable history slots and invalidates them at explicit frame boundaries. */
export class HistoryRegistry {
  private readonly records = new Map<string, HistoryRecord>();
  private readonly nextInvalidation = new Map<string, HistoryInvalidationReason>();
  private nextReservationId = 1;

  constructor(private readonly device: RHIDevice) {
    void device.lost.then(() => this.invalidateAll('device-lost'));
  }

  acquire(identity: HistoryIdentity): AcquiredHistorySlot {
    validateIdentity(identity);
    if (identity.deviceGeneration !== this.device.generation) {
      throw new Error('History identity belongs to a different device generation.');
    }
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

    if (record.activeReservationId !== undefined) {
      return acquisitionFor(record, record.activeReservationId);
    }
    const readable = readableSlot(record);
    const writable = writableSlot(record, readable?.slot);
    if (writable === undefined) throw new Error(`History "${identity.key}" has no writable slots.`);
    const reservationId = this.nextReservationId++;
    writable.slotState.reservationId = reservationId;
    record.activeReservationId = reservationId;
    return acquisitionFor(record, reservationId);
  }

  publish(
    identity: HistoryIdentity,
    acquired: AcquiredHistorySlot,
    submission: RHISubmission
  ): void {
    const record = this.requiredRecord(identity);
    this.assertAcquiredBinding(identity, acquired);
    const slotIndex = acquired.writable.slot;
    const slot = record.slots[slotIndex] as HistorySlot;
    if (slot.retainingSubmissionIds.size > 0)
      throw new Error(`History slot ${slotIndex} is still pending.`);

    slot.producerSubmissionId = submission.id;
    slot.publicationOrder = record.nextPublicationOrder++;
    slot.valid = true;
    slot.invalidationReason = undefined;
    this.releaseReservation(record, acquired.reservationId);
    this.retain(identity, slotIndex, submission);
    record.nextSlot = (slotIndex + 1) % record.slots.length;
  }

  /** Releases an output reservation when a frame does not submit a new history value. */
  abandon(identity: HistoryIdentity, acquired: AcquiredHistorySlot): void {
    const record = this.requiredRecord(identity);
    this.assertAcquiredBinding(identity, acquired);
    this.releaseReservation(record, acquired.reservationId);
  }

  retain(identity: HistoryIdentity, slotIndex: number, submission: RHISubmission): void {
    const record = this.requiredRecord(identity);
    const slot = record.slots[slotIndex];
    if (slot === undefined) throw new Error(`History slot ${slotIndex} does not exist.`);
    if (slot.retired) throw new Error(`History slot ${slotIndex} is retiring.`);
    if (slot.retainingSubmissionIds.has(submission.id)) return;
    // Readers and producers can retire on different submissions, so one terminal set owns safety.
    slot.retainingSubmissionIds.add(submission.id);
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

  /** Stable native-object-free state for execution Debug IR and capture tooling. */
  debugState(identity: HistoryIdentity): readonly HistorySlotDebugState[] {
    const record = this.requiredRecord(identity);
    return Object.freeze(
      record.slots.map((slot, index) =>
        Object.freeze({
          slot: index,
          valid: slot.valid,
          invalidationReason: slot.invalidationReason,
          producerSubmissionId: slot.producerSubmissionId,
          pendingSubmissionIds: Object.freeze(
            [...slot.retainingSubmissionIds].sort((a, b) => a - b)
          ),
          pendingRetirement: slot.retired && slot.retainingSubmissionIds.size > 0
        })
      )
    );
  }

  /** Verifies that an execution binding is the exact slot acquired from this registry. */
  assertAcquiredBinding(identity: HistoryIdentity, acquired: AcquiredHistorySlot): void {
    const record = this.requiredRecord(identity);
    const writable = record.slots[acquired.writable.slot];
    const readable = readableSlot(record);
    const readableMatches =
      acquired.readable === undefined
        ? readable === undefined
        : readable !== undefined &&
          acquired.readable.slot === readable.slot &&
          acquired.readable.handle === readable.slotState.handle;
    if (
      writable === undefined ||
      writable.handle !== acquired.writable.handle ||
      writable.reservationId !== acquired.reservationId ||
      record.activeReservationId !== acquired.reservationId ||
      !readableMatches
    ) {
      throw new Error('History execution binding does not match its acquired registry slot.');
    }
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

  /** Retires only history identities produced by the previous policy-domain hash. */
  invalidateFeaturePolicy(invalidation: FeaturePolicyCacheInvalidation): void {
    if (invalidation.domain !== 'history' || invalidation.previousHash === null) return;
    for (const [key, record] of this.records) {
      if (record.identity.policy !== invalidation.previousHash) continue;
      this.retireRecord(record);
      this.records.delete(key);
      this.nextInvalidation.set(key, 'policy-changed');
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
        retainingSubmissionIds: new Set(),
        producerSubmissionId: undefined,
        valid: false,
        invalidationReason: reason,
        publicationOrder: -1,
        reservationId: undefined,
        retired: false
      })),
      nextSlot: 0,
      nextPublicationOrder: 0,
      activeReservationId: undefined,
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
    if (!slot.retainingSubmissionIds.delete(submissionId)) return;
    if (slot.producerSubmissionId === submissionId) {
      if (result.status !== 'completed' || record.retired) {
        slot.valid = false;
        slot.invalidationReason =
          result.status === 'device-lost' ? 'device-lost' : 'submission-failed';
      }
    }
    if (slot.retired && slot.retainingSubmissionIds.size === 0) slot.handle.dispose();
  }

  private retireRecord(record: HistoryRecord): void {
    if (record.retired) return;
    record.retired = true;
    record.activeReservationId = undefined;
    for (const slot of record.slots) {
      slot.retired = true;
      slot.valid = false;
      slot.reservationId = undefined;
      if (slot.retainingSubmissionIds.size === 0) slot.handle.dispose();
    }
  }

  private invalidateAll(reason: HistoryInvalidationReason): void {
    for (const [key, record] of this.records) {
      this.retireRecord(record);
      this.records.delete(key);
      this.nextInvalidation.set(key, reason);
    }
  }

  private releaseReservation(record: HistoryRecord, reservationId: number): void {
    const slot = record.slots.find((candidate) => candidate.reservationId === reservationId);
    if (slot === undefined || record.activeReservationId !== reservationId) {
      throw new Error('History output reservation is no longer active.');
    }
    slot.reservationId = undefined;
    record.activeReservationId = undefined;
  }
}

interface IndexedHistorySlot {
  readonly slot: number;
  readonly slotState: HistorySlot;
}

function readableSlot(record: HistoryRecord): IndexedHistorySlot | undefined {
  let latest: IndexedHistorySlot | undefined;
  for (let index = 0; index < record.slots.length; index += 1) {
    const slot = record.slots[index] as HistorySlot;
    if (!slot.valid || slot.retired) continue;
    if (latest === undefined || slot.publicationOrder > latest.slotState.publicationOrder) {
      latest = { slot: index, slotState: slot };
    }
  }
  return latest;
}

function writableSlot(
  record: HistoryRecord,
  readableSlotIndex: number | undefined
): IndexedHistorySlot | undefined {
  for (let offset = 0; offset < record.slots.length; offset += 1) {
    const index = (record.nextSlot + offset) % record.slots.length;
    const slot = record.slots[index];
    if (
      slot !== undefined &&
      index !== readableSlotIndex &&
      !slot.retired &&
      slot.reservationId === undefined &&
      slot.retainingSubmissionIds.size === 0
    )
      return { slot: index, slotState: slot };
  }
  return undefined;
}

function acquisitionFor(record: HistoryRecord, reservationId: number): AcquiredHistorySlot {
  const writable = record.slots.findIndex((slot) => slot.reservationId === reservationId);
  const writableState = record.slots[writable];
  if (writableState === undefined) throw new Error('History output reservation is missing.');
  const readable = readableSlot(record);
  return Object.freeze({
    readable:
      readable === undefined
        ? undefined
        : Object.freeze({
            handle: readable.slotState.handle,
            slot: readable.slot,
            valid: true as const,
            invalidationReason: undefined
          }),
    writable: Object.freeze({
      handle: writableState.handle,
      slot: writable,
      valid: false as const,
      invalidationReason: writableState.invalidationReason
    }),
    reservationId
  });
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
  if (!Number.isSafeInteger(identity.slots) || identity.slots < 2) {
    throw new Error(
      'History requires at least two slots so readable and writable content are distinct.'
    );
  }
  if (identity.key.length === 0) throw new Error('History key must not be empty.');
  if (identity.sharedScope !== undefined && identity.sharedScope.length === 0) {
    throw new Error('History sharedScope must not be empty.');
  }
  if (
    identity.sharedScope === undefined &&
    (identity.viewId === undefined || identity.viewId.length === 0)
  ) {
    throw new Error('History identity requires a viewId or an explicit sharedScope.');
  }
}

function identityKey(identity: HistoryIdentity): string {
  return stableValue({
    scope:
      identity.sharedScope === undefined
        ? { kind: 'view', value: identity.viewId }
        : { kind: 'shared', value: identity.sharedScope },
    key: identity.key
  });
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

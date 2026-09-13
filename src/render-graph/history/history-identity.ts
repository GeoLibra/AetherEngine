import type {
  HistoryInvalidationReason,
  TransientAllocationDescriptor,
  TransientResource
} from '../types';

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

export function validateIdentity(identity: HistoryIdentity): void {
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

export function identityKey(identity: HistoryIdentity): string {
  return stableValue({
    scope:
      identity.sharedScope === undefined
        ? { kind: 'view', value: identity.viewId }
        : { kind: 'shared', value: identity.sharedScope },
    key: identity.key
  });
}

export function configurationKey(identity: HistoryIdentity): string {
  return stableValue({
    deviceGeneration: identity.deviceGeneration,
    descriptor: identity.descriptor,
    slots: identity.slots,
    abi: identity.abi,
    policy: identity.policy
  });
}

export function changedReason(
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

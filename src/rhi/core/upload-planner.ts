/** Limits applied to CPU-to-GPU uploads scheduled during one render frame. */
export interface UploadPlannerOptions {
  /** Total byte capacity of the reusable staging ring. Must be alignment-sized. */
  readonly capacityBytes: number;
  /** Maximum caller payload bytes accepted during one frame. */
  readonly maxFrameBytes: number;
  /** Maximum accepted upload operations during one frame. */
  readonly maxFrameCommands: number;
  /** Required byte alignment for every staging range. */
  readonly alignment: number;
}

/** A non-overlapping staging allocation admitted by the current frame budget. */
export interface UploadReservation {
  readonly status: 'admitted';
  readonly offset: number;
  readonly byteLength: number;
  readonly size: number;
}

/** An upload withheld before it can reach a backend queue. */
export interface DeferredUploadReservation {
  readonly status: 'deferred';
  readonly reason: 'frame-byte-budget' | 'frame-command-budget' | 'ring-capacity';
}

/** Immutable observability snapshot for one planner frame. */
export interface UploadPlannerSnapshot {
  readonly frame: number;
  readonly capacityBytes: number;
  readonly allocatedBytes: number;
  readonly allocatedCommands: number;
  readonly reservedBytes: number;
  readonly liveBytes: number;
  readonly deferred: Readonly<{
    'frame-byte-budget': number;
    'frame-command-budget': number;
    'ring-capacity': number;
  }>;
}

interface LiveAllocation {
  readonly frame: number;
  readonly offset: number;
  readonly size: number;
  readonly byteLength: number;
}

/**
 * Owns frame-local upload admission and a submission-epoch-protected staging ring.
 *
 * The planner never submits work or retains caller upload bytes. Backends still own the actual
 * queue write, while callers retain the returned range until the frame's submission is terminal.
 */
export class UploadPlanner {
  private readonly allocations: LiveAllocation[] = [];
  private readonly reservationAllocations = new WeakMap<UploadReservation, LiveAllocation>();
  private readonly deferred = {
    'frame-byte-budget': 0,
    'frame-command-budget': 0,
    'ring-capacity': 0
  };
  private currentFrame: number | undefined;
  private nextOffset = 0;
  private allocatedBytes = 0;
  private allocatedCommands = 0;
  private reservedBytes = 0;

  constructor(private readonly options: UploadPlannerOptions) {
    validateOptions(options);
  }

  /** Starts a monotonically newer frame and clears only that frame's accounting. */
  beginFrame(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error(`Upload frame ${frame} must be a non-negative safe integer.`);
    }
    if (this.currentFrame !== undefined && frame <= this.currentFrame) {
      throw new Error(
        `Upload frame ${frame} must be newer than current frame ${this.currentFrame}.`
      );
    }
    this.currentFrame = frame;
    this.allocatedBytes = 0;
    this.allocatedCommands = 0;
    this.reservedBytes = 0;
    this.deferred['frame-byte-budget'] = 0;
    this.deferred['frame-command-budget'] = 0;
    this.deferred['ring-capacity'] = 0;
  }

  /**
   * Reserves one aligned staging range or returns the explicit budget that withheld it.
   *
   * @throws When no frame is active or byteLength is not a positive safe integer.
   */
  reserve(byteLength: number): UploadReservation | DeferredUploadReservation {
    const frame = this.requireFrame();
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new Error(`Upload byteLength ${byteLength} must be a positive safe integer.`);
    }
    if (this.allocatedBytes + byteLength > this.options.maxFrameBytes) {
      return this.defer('frame-byte-budget');
    }
    if (this.allocatedCommands + 1 > this.options.maxFrameCommands) {
      return this.defer('frame-command-budget');
    }
    const size = align(byteLength, this.options.alignment);
    const offset = this.findAvailableOffset(size);
    if (offset === undefined) return this.defer('ring-capacity');

    const allocation: LiveAllocation = { frame, offset, size, byteLength };
    this.allocations.push(allocation);
    this.nextOffset = (offset + size) % this.options.capacityBytes;
    this.allocatedBytes += byteLength;
    this.allocatedCommands += 1;
    this.reservedBytes += size;
    const reservation = Object.freeze({ status: 'admitted' as const, offset, byteLength, size });
    this.reservationAllocations.set(reservation, allocation);
    return reservation;
  }

  /**
   * Rolls back an admitted range that could not be accepted by its backend queue.
   *
   * A reservation can only be released once and only by the planner that admitted it.
   */
  release(reservation: UploadReservation): void {
    const allocation = this.reservationAllocations.get(reservation);
    if (allocation === undefined)
      throw new Error('Upload reservation is not live for this planner.');
    const index = this.allocations.indexOf(allocation);
    if (index < 0) throw new Error('Upload reservation has already been retired.');
    this.allocations.splice(index, 1);
    this.reservationAllocations.delete(reservation);
    if (allocation.frame === this.currentFrame) {
      this.allocatedBytes -= allocation.byteLength;
      this.allocatedCommands -= 1;
      this.reservedBytes -= allocation.size;
    }
  }

  /**
   * Retires one live staging range when its owning submission becomes terminal.
   *
   * Frame admission counters intentionally remain unchanged: they describe work accepted during
   * that frame, whereas `liveBytes` describes ranges that are still unsafe to reuse.
   */
  retireAfter(reservation: UploadReservation, submission: RHISubmission): void {
    this.requireLiveReservation(reservation);
    void submission.done.then(() => this.retireReservation(reservation));
  }

  /** Retires every staging range whose submission epoch has reached a terminal result. */
  retireThrough(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error(`Retired upload frame ${frame} must be a non-negative safe integer.`);
    }
    for (let index = this.allocations.length - 1; index >= 0; index -= 1) {
      const allocation = this.allocations[index]!;
      if (allocation.frame <= frame) this.allocations.splice(index, 1);
    }
  }

  /** Returns detached, immutable frame and ring observations. */
  snapshot(): UploadPlannerSnapshot {
    const frame = this.requireFrame();
    const liveBytes = this.allocations.reduce((total, allocation) => total + allocation.size, 0);
    return Object.freeze({
      frame,
      capacityBytes: this.options.capacityBytes,
      allocatedBytes: this.allocatedBytes,
      allocatedCommands: this.allocatedCommands,
      reservedBytes: this.reservedBytes,
      liveBytes,
      deferred: Object.freeze({ ...this.deferred })
    });
  }

  private defer(reason: DeferredUploadReservation['reason']): DeferredUploadReservation {
    this.deferred[reason] += 1;
    return Object.freeze({ status: 'deferred', reason });
  }

  private requireLiveReservation(reservation: UploadReservation): LiveAllocation {
    const allocation = this.reservationAllocations.get(reservation);
    if (allocation === undefined || !this.allocations.includes(allocation)) {
      throw new Error('Upload reservation is not live for this planner.');
    }
    return allocation;
  }

  private retireReservation(reservation: UploadReservation): void {
    const allocation = this.reservationAllocations.get(reservation);
    if (allocation === undefined) return;
    const index = this.allocations.indexOf(allocation);
    if (index < 0) return;
    this.allocations.splice(index, 1);
    this.reservationAllocations.delete(reservation);
  }

  private requireFrame(): number {
    if (this.currentFrame === undefined)
      throw new Error('UploadPlanner requires beginFrame before use.');
    return this.currentFrame;
  }

  private findAvailableOffset(size: number): number | undefined {
    const candidates = this.nextOffset === 0 ? [0] : [this.nextOffset, 0];
    for (const offset of candidates) {
      if (offset + size > this.options.capacityBytes) continue;
      if (
        this.allocations.every((entry) => !rangesOverlap(offset, size, entry.offset, entry.size))
      ) {
        return offset;
      }
    }
    return undefined;
  }
}

function validateOptions(options: UploadPlannerOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} ${value} must be a positive safe integer.`);
    }
  }
  if (options.capacityBytes % options.alignment !== 0) {
    throw new Error(
      `capacityBytes ${options.capacityBytes} must be a multiple of alignment ${options.alignment}.`
    );
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function rangesOverlap(
  firstOffset: number,
  firstSize: number,
  secondOffset: number,
  secondSize: number
): boolean {
  return firstOffset < secondOffset + secondSize && secondOffset < firstOffset + firstSize;
}
import type { RHISubmission } from '../contracts';

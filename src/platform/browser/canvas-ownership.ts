/**
 * @file Exclusive canvas ownership lease and registry for browser graphics sessions.
 */

/**
 * Handle representing an exclusive lease on an HTMLCanvasElement or OffscreenCanvas.
 */
export interface CanvasLease {
  /** Unique session identity holding the lease. */
  readonly sessionId: symbol;

  /** Unique lease identity distinguishing this specific acquisition. */
  readonly leaseId: symbol;

  /** The canvas associated with this lease. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;

  /** Checks whether this lease is still active and recognized as the current owner. */
  readonly isCurrent: () => boolean;

  /** Releases ownership of the canvas, allowing subsequent sessions to acquire it. */
  readonly release: () => void;
}

/** Record tracking the active lease for a canvas. */
interface ActiveLeaseRecord {
  readonly sessionId: symbol;
  readonly leaseId: symbol;
}

/**
 * Registry enforcing that a single canvas element is leased by at most one active graphics session at a time.
 *
 * Uses a WeakMap to ensure zero memory leaks when canvas DOM nodes are garbage collected.
 */
export class CanvasOwnershipRegistry {
  private readonly owners = new WeakMap<HTMLCanvasElement | OffscreenCanvas, ActiveLeaseRecord>();

  /**
   * Acquires exclusive ownership of a canvas for a graphics session.
   *
   * @param canvas The target canvas element or offscreen canvas.
   * @param sessionId Unique symbol identifying the requesting session.
   * @returns An exclusive CanvasLease token.
   * @throws {Error} When the canvas is already owned by an active graphics session.
   */
  acquire(canvas: HTMLCanvasElement | OffscreenCanvas, sessionId: symbol): CanvasLease {
    const existing = this.owners.get(canvas);
    if (existing !== undefined) {
      throw new Error(
        '[canvas-ownership-conflict] Canvas is already owned by an active graphics session.'
      );
    }
    const leaseId = Symbol('canvas-lease');
    this.owners.set(canvas, { sessionId, leaseId });

    let released = false;
    return Object.freeze({
      sessionId,
      leaseId,
      canvas,
      isCurrent: () => !released && this.owners.get(canvas)?.leaseId === leaseId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.owners.get(canvas);
        if (current?.leaseId === leaseId) {
          this.owners.delete(canvas);
        }
      }
    });
  }
}

/** Global default canvas ownership registry for browser runtime sessions. */
export const defaultCanvasOwnershipRegistry = new CanvasOwnershipRegistry();

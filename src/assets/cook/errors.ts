/** Signals that a published pointer changed after a cook transaction captured its base revision. */
export class CookPublishedPointerConflictError extends Error {
  constructor(
    readonly nodeId: string,
    readonly currentRevision: string | undefined
  ) {
    super(
      `[cook-published-pointer-conflict] Cook published pointer compare-and-swap failed for ${nodeId}.`
    );
    this.name = 'CookPublishedPointerConflictError';
  }
}

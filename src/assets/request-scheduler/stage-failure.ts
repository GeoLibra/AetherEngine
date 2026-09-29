/** Typed executor failure whose category controls automatic retry classification. */
export class AssetRequestStageFailure extends Error {
  readonly failure: string;

  readonly retryAfterMilliseconds?: number;

  /**
   * Creates one classified stage failure.
   *
   * @throws If the failure category/message is empty or retry-after is not a non-negative safe
   * integer in milliseconds.
   */
  constructor(failure: string, message: string, retryAfterMilliseconds?: number) {
    super(message);
    if (typeof failure !== 'string' || !failure.trim()) {
      throw new Error('Asset stage failure category must be non-empty.');
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('Asset stage failure message must be non-empty.');
    }
    if (
      retryAfterMilliseconds !== undefined &&
      (!Number.isSafeInteger(retryAfterMilliseconds) || retryAfterMilliseconds < 0)
    ) {
      throw new Error('Asset stage retry-after delay must be a non-negative safe integer.');
    }
    this.name = 'AssetRequestStageFailure';
    this.failure = failure;
    if (retryAfterMilliseconds !== undefined) {
      this.retryAfterMilliseconds = retryAfterMilliseconds;
    }
  }
}

import type { BrowserGraphicsAttempt } from './types/browser-graphics-types';

export class BrowserGraphicsBootstrapError extends Error {
  readonly code = 'platform/browser-graphics-unavailable';

  constructor(readonly attempts: readonly BrowserGraphicsAttempt[]) {
    super('No requested browser graphics backend could be created.');
    this.name = 'BrowserGraphicsBootstrapError';
  }
}

/**
 * @file CPU-level environment asset publisher and revision tracker.
 * Manages staged revisions, last-good retention, and immutable snapshot publication.
 */

import type { EnvironmentAsset } from './types';

export class EnvironmentAssetProvider {
  private currentAsset?: EnvironmentAsset;
  private lastGoodAsset?: EnvironmentAsset;
  private currentRevision = 0;

  /**
   * Publishes a newly loaded or updated EnvironmentAsset.
   * Retains the previous asset as last-good until the new asset is confirmed.
   *
   * @param asset - The newly validated environment asset.
   * @returns Incremented revision number.
   */
  publish(asset: EnvironmentAsset): number {
    if (this.currentAsset !== undefined) {
      this.lastGoodAsset = this.currentAsset;
    }
    this.currentAsset = asset;
    this.currentRevision += 1;
    return this.currentRevision;
  }

  /**
   * Retrieves the currently active published asset, if available.
   */
  current(): EnvironmentAsset | undefined {
    return this.currentAsset;
  }

  /**
   * Retrieves the last known good published asset, for fallback during failed HMR/recovery.
   */
  lastGood(): EnvironmentAsset | undefined {
    return this.lastGoodAsset ?? this.currentAsset;
  }

  /**
   * Retrieves the current CPU publication revision number.
   */
  revision(): number {
    return this.currentRevision;
  }
}

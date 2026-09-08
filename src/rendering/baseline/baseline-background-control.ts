/**
 * @file Baseline background runtime control resource and service definition.
 * Decouples dynamic background configuration from plugin instances and exposes
 * observable change-tracking semantics consumed at scheduled apply points.
 */

import { defineResource } from '../../ecs/resource';
import { createServiceToken } from '../../app/utils';
import type { ServiceToken } from '../../app/types';
import type { ViewBackground } from '../background/types';
import { validateBackgroundOption } from './baseline-options';

/**
 * Contractual runtime control for updating view background configuration.
 * Exposes observable pending state and change-tracking semantics for scheduled apply points.
 */
export interface BaselineBackgroundControl {
  /** Active or pending background configuration override. `undefined` uses statically configured background. */
  readonly current: ViewBackground | undefined;
  /** True when a pending background update has been requested and not yet consumed by the renderer. */
  readonly isDirty: boolean;
  /** Sets the active background configuration for subsequent frames. */
  setBackground(bg: ViewBackground): void;
  /** Clears the background override, restoring the statically configured background. */
  clearBackground(): void;
  /** Consumes and resets the dirty flag at the scheduled apply point. */
  consumeDirty(): boolean;
}

/** Default implementation of the BaselineBackgroundControl contract. */
export class BaselineBackgroundControlImpl implements BaselineBackgroundControl {
  private _current: ViewBackground | undefined;
  private _dirty = false;
  private disposed = false;

  constructor(initial?: ViewBackground) {
    this._current = validateBackgroundOption(initial);
    this._dirty = initial !== undefined;
  }

  get current(): ViewBackground | undefined {
    return this._current;
  }

  get isDirty(): boolean {
    return this._dirty;
  }

  setBackground(bg: ViewBackground): void {
    this.assertLive();
    const validated = validateBackgroundOption(bg);
    this._current = validated;
    this._dirty = true;
  }

  clearBackground(): void {
    this.assertLive();
    this._current = undefined;
    this._dirty = true;
  }

  consumeDirty(): boolean {
    this.assertLive();
    const dirty = this._dirty;
    this._dirty = false;
    return dirty;
  }

  /** Invalidates this App-owned controller when its plugin shuts down. */
  dispose(): void {
    this.disposed = true;
    this._current = undefined;
    this._dirty = false;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Baseline background control has been disposed.');
  }
}

/** Strongly typed ECS resource token for baseline background runtime control. */
export const BaselineBackgroundControlResource = defineResource<BaselineBackgroundControl>(
  'aether.rendering.baseline.background-control'
);

/** Strongly typed App service token for baseline background runtime control. */
export const BaselineBackgroundService: ServiceToken<BaselineBackgroundControl> =
  createServiceToken<BaselineBackgroundControl>('baseline-background-control');

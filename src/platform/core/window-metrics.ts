import { DEFAULT_DEVICE_PIXEL_RATIO } from '../constants';
import type { WindowMetrics, WindowMetricsUpdate, WindowOptions } from '../types';

function validateLogicalSize(size: readonly [number, number]): void {
  if (!Number.isFinite(size[0]) || size[0] < 0 || !Number.isFinite(size[1]) || size[1] < 0) {
    throw new Error('Window logical size must contain non-negative finite values.');
  }
}

function validateDevicePixelRatio(dpr: number): void {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error('Window devicePixelRatio must be a positive finite number.');
  }
}

export function createWindowMetrics(options: WindowOptions): WindowMetrics {
  validateLogicalSize(options.logicalSize);
  const logicalSize = Object.freeze([options.logicalSize[0], options.logicalSize[1]] as const);
  const devicePixelRatio = options.devicePixelRatio ?? DEFAULT_DEVICE_PIXEL_RATIO;
  validateDevicePixelRatio(devicePixelRatio);
  const physicalSize = Object.freeze([
    Math.round(logicalSize[0] * devicePixelRatio),
    Math.round(logicalSize[1] * devicePixelRatio)
  ] as const);
  return Object.freeze({
    logicalSize,
    physicalSize,
    devicePixelRatio,
    visible: options.visible ?? true,
    focused: options.focused ?? false
  });
}

export function updateWindowMetrics(
  current: WindowMetrics,
  update: WindowMetricsUpdate
): WindowMetrics {
  if (update.logicalSize !== undefined) {
    validateLogicalSize(update.logicalSize);
  }
  if (update.devicePixelRatio !== undefined) {
    validateDevicePixelRatio(update.devicePixelRatio);
  }
  const logicalSize = update.logicalSize
    ? Object.freeze([update.logicalSize[0], update.logicalSize[1]] as const)
    : current.logicalSize;
  const devicePixelRatio = update.devicePixelRatio ?? current.devicePixelRatio;
  const physicalSize = Object.freeze([
    Math.round(logicalSize[0] * devicePixelRatio),
    Math.round(logicalSize[1] * devicePixelRatio)
  ] as const);
  return Object.freeze({
    logicalSize,
    physicalSize,
    devicePixelRatio,
    visible: update.visible ?? current.visible,
    focused: update.focused ?? current.focused
  });
}

export function equalWindowMetrics(a: WindowMetrics, b: WindowMetrics): boolean {
  return (
    a.logicalSize[0] === b.logicalSize[0] &&
    a.logicalSize[1] === b.logicalSize[1] &&
    a.physicalSize[0] === b.physicalSize[0] &&
    a.physicalSize[1] === b.physicalSize[1] &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.visible === b.visible &&
    a.focused === b.focused
  );
}

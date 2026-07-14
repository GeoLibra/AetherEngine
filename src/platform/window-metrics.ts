import { DEFAULT_DEVICE_PIXEL_RATIO } from './constants';
import type { WindowMetrics, WindowMetricsUpdate, WindowOptions } from './types';

interface WindowMetricValues {
  readonly logicalSize: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly visible: boolean;
  readonly focused: boolean;
}

export function createWindowMetrics(options: WindowOptions): WindowMetrics {
  return normalizeWindowMetrics({
    logicalSize: options.logicalSize,
    devicePixelRatio: options.devicePixelRatio ?? DEFAULT_DEVICE_PIXEL_RATIO,
    visible: options.visible ?? true,
    focused: options.focused ?? false
  });
}

export function updateWindowMetrics(
  current: WindowMetrics,
  update: WindowMetricsUpdate
): WindowMetrics {
  return normalizeWindowMetrics({
    logicalSize: update.logicalSize ?? current.logicalSize,
    devicePixelRatio: update.devicePixelRatio ?? current.devicePixelRatio,
    visible: update.visible ?? current.visible,
    focused: update.focused ?? current.focused
  });
}

export function equalWindowMetrics(left: WindowMetrics, right: WindowMetrics): boolean {
  return (
    left.logicalSize[0] === right.logicalSize[0] &&
    left.logicalSize[1] === right.logicalSize[1] &&
    left.physicalSize[0] === right.physicalSize[0] &&
    left.physicalSize[1] === right.physicalSize[1] &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.visible === right.visible &&
    left.focused === right.focused
  );
}

function normalizeWindowMetrics(values: WindowMetricValues): WindowMetrics {
  validateLogicalSize(values.logicalSize);
  if (!Number.isFinite(values.devicePixelRatio) || values.devicePixelRatio <= 0) {
    throw new Error('Window devicePixelRatio must be a positive finite number.');
  }

  const logicalSize = freezeSize(values.logicalSize[0], values.logicalSize[1]);
  const physicalSize = freezeSize(
    Math.round(logicalSize[0] * values.devicePixelRatio),
    Math.round(logicalSize[1] * values.devicePixelRatio)
  );
  return Object.freeze({
    logicalSize,
    physicalSize,
    devicePixelRatio: values.devicePixelRatio,
    visible: values.visible,
    focused: values.focused
  });
}

function validateLogicalSize(size: readonly [number, number]): void {
  if (size.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Window logical size must contain non-negative finite values.');
  }
}

function freezeSize(width: number, height: number): readonly [number, number] {
  return Object.freeze([width, height]);
}

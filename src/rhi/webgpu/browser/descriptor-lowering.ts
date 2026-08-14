import type { WebGPUNativeDeviceRequest } from '../native-types';

export function lowerBrowserDeviceDescriptor(
  request: WebGPUNativeDeviceRequest
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(request.label === undefined ? {} : { label: request.label }),
    requiredFeatures: Object.freeze([...request.requiredFeatures]),
    requiredLimits: Object.freeze({ ...request.requiredLimits })
  });
}

export function lowerBrowserBufferDescriptor(
  descriptor: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return copyDefined(descriptor, ['label', 'size', 'usage', 'mappedAtCreation']);
}

export function lowerBrowserTextureDescriptor(
  descriptor: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const lowered = copyDefined(descriptor, [
    'label', 'mipLevelCount', 'sampleCount', 'dimension', 'format', 'usage', 'viewFormats'
  ]);
  const size = descriptor.size;
  if (!isRecord(size)) throw new TypeError('WebGPU texture descriptor requires an object size.');
  return Object.freeze({
    ...lowered,
    size: Object.freeze({
      width: requireNumber(size, 'width'),
      height: requireNumber(size, 'height'),
      depthOrArrayLayers: requireNumber(size, 'depthOrArrayLayers')
    })
  });
}

export function lowerBrowserDescriptor(
  descriptor: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  lowerResource: (value: unknown) => unknown
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = descriptor[key];
    if (value !== undefined) result[key] = lowerDescriptorValue(value, lowerResource);
  }
  return Object.freeze(result);
}

function lowerDescriptorValue(value: unknown, lowerResource: (value: unknown) => unknown): unknown {
  const loweredResource = lowerResource(value);
  if (loweredResource !== value) return loweredResource;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => lowerDescriptorValue(entry, lowerResource)));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = lowerDescriptorValue(entry, lowerResource);
  }
  return Object.freeze(result);
}

function copyDefined(
  descriptor: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = descriptor[key];
    if (value !== undefined) result[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(result);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function requireNumber(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new TypeError(`WebGPU descriptor field ${key} must be a number.`);
  return value;
}

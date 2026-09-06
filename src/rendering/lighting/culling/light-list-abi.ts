import { orderLightsForGpu } from '../core/light';
import type { CpuLightListCapacity, LightReceiver, PreparedLight } from '../types';

export const LIGHT_LIST_ABI_VERSION = 2;
export const LIGHT_LIST_HEADER_WORDS = 4;
export const LIGHT_LIST_LIGHT_WORDS = 12;
export const LIGHT_LIST_RECEIVER_WORDS = 12;
export const LIGHT_LIST_SHADER_MAX_LIGHTS = 256;
export const LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS = 64;
export const LIGHT_LIST_SHADER_MAX_RECEIVERS = 256;
export const LIGHT_LIST_SHADER_MAX_INDICES = 4096;

export interface PackedWebGpuLightListInput {
  readonly orderedLights: readonly PreparedLight[];
  readonly lights: Uint32Array;
  readonly receivers: Uint32Array;
}

export interface DecodedWebGpuLightListOutput {
  readonly directionalIndices: readonly number[];
  readonly headers: readonly Readonly<{
    receiver: number;
    offset: number;
    count: number;
    overflowed: boolean;
  }>[];
  readonly lightIndices: readonly number[];
  readonly overflowed: boolean;
}

/** Packs validated light-list input into caller-owned upload arrays for the built-in kernel. */
export function packWebGpuLightListInput(input: {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
  readonly capacity: CpuLightListCapacity;
}): PackedWebGpuLightListInput {
  assertUint32(input.viewLayerMask, 'Light-list view layer mask');
  validateCapacity(input.capacity);
  if (input.lights.length > LIGHT_LIST_SHADER_MAX_LIGHTS)
    throw new Error(
      `Light-list input exceeds the shader maximum of ${LIGHT_LIST_SHADER_MAX_LIGHTS} lights.`
    );
  if (input.receivers.length > LIGHT_LIST_SHADER_MAX_RECEIVERS)
    throw new Error(
      `Light-list input exceeds the shader maximum of ${LIGHT_LIST_SHADER_MAX_RECEIVERS} receivers.`
    );
  const orderedLights = orderLightsForGpu(input.lights);
  const receivers = [...input.receivers].sort(
    (left, right) => left.renderEntity - right.renderEntity
  );
  const lightWords = new Uint32Array(
    LIGHT_LIST_HEADER_WORDS + orderedLights.length * LIGHT_LIST_LIGHT_WORDS
  );
  lightWords[0] = orderedLights.length;
  lightWords[1] = input.viewLayerMask;
  orderedLights.forEach((light, index) => {
    assertUint32(light.entity, 'Light-list light entity');
    const base = LIGHT_LIST_HEADER_WORDS + index * LIGHT_LIST_LIGHT_WORDS;
    lightWords[base] = light.kind === 'directional' ? 0 : light.kind === 'point' ? 1 : 2;
    lightWords[base + 1] = light.enabled ? 1 : 0;
    lightWords[base + 2] = light.layerMask;
    lightWords[base + 3] = light.entity;
    if (light.kind === 'directional') {
      writeFloat(lightWords, base + 4, light.direction[0]);
      writeFloat(lightWords, base + 5, light.direction[1]);
      writeFloat(lightWords, base + 6, light.direction[2]);
      writeFloat(lightWords, base + 11, light.illuminanceLux);
    } else {
      writeFloat(lightWords, base + 4, light.position[0]);
      writeFloat(lightWords, base + 5, light.position[1]);
      writeFloat(lightWords, base + 6, light.position[2]);
      writeFloat(lightWords, base + 7, light.range);
      writeFloat(lightWords, base + 11, light.luminousIntensityCandela);
    }
    writeFloat(lightWords, base + 8, light.colorLinear[0]);
    writeFloat(lightWords, base + 9, light.colorLinear[1]);
    writeFloat(lightWords, base + 10, light.colorLinear[2]);
  });
  const receiverWords = new Uint32Array(
    LIGHT_LIST_HEADER_WORDS + receivers.length * LIGHT_LIST_RECEIVER_WORDS
  );
  receiverWords[0] = receivers.length;
  receiverWords[1] = input.capacity.maxLightsPerReceiver;
  receiverWords[2] = input.capacity.maxDirectionalLights;
  receiverWords[3] = input.capacity.maxLightIndices;
  receivers.forEach((receiver, index) => {
    validateReceiver(receiver, receivers[index - 1]);
    const base = LIGHT_LIST_HEADER_WORDS + index * LIGHT_LIST_RECEIVER_WORDS;
    receiverWords[base] = receiver.renderEntity;
    receiverWords[base + 1] = receiver.enabled === false ? 0 : 1;
    receiverWords[base + 2] = receiver.layerMask;
    receiverWords[base + 3] = receiver.bounds.kind === 'sphere' ? 0 : 1;
    const minimum =
      receiver.bounds.kind === 'sphere' ? receiver.bounds.center : receiver.bounds.min;
    writeFloat(receiverWords, base + 4, minimum[0]);
    writeFloat(receiverWords, base + 5, minimum[1]);
    writeFloat(receiverWords, base + 6, minimum[2]);
    if (receiver.bounds.kind === 'sphere') {
      writeFloat(receiverWords, base + 7, receiver.bounds.radius);
    } else {
      writeFloat(receiverWords, base + 8, receiver.bounds.max[0]);
      writeFloat(receiverWords, base + 9, receiver.bounds.max[1]);
      writeFloat(receiverWords, base + 10, receiver.bounds.max[2]);
    }
  });
  return { orderedLights, lights: lightWords, receivers: receiverWords };
}

/** Decodes copied storage-buffer words and rejects counts outside their captured buffers. */
export function decodeWebGpuLightListOutput(input: {
  readonly directionalIndices: Uint32Array;
  readonly headers: Uint32Array;
  readonly lightIndices: Uint32Array;
  readonly overflow: Uint32Array;
}): DecodedWebGpuLightListOutput {
  if (input.overflow.length < 3) throw new Error('Light-list overflow readback is truncated.');
  const flagsAndDirectionalCount = input.overflow[0]!;
  const directionalCount = flagsAndDirectionalCount & 0x3fff_ffff;
  const headerCount = input.overflow[1]!;
  const indexCount = input.overflow[2]!;
  if (directionalCount > input.directionalIndices.length)
    throw new Error('Light-list directional count exceeds its readback buffer.');
  if (headerCount * 4 > input.headers.length)
    throw new Error('Light-list header count exceeds its readback buffer.');
  if (indexCount > input.lightIndices.length)
    throw new Error('Light-list index count exceeds its readback buffer.');
  const headers = Array.from({ length: headerCount }, (_, index) => {
    const base = index * 4;
    return Object.freeze({
      receiver: input.headers[base]!,
      offset: input.headers[base + 1]!,
      count: input.headers[base + 2]!,
      overflowed: input.headers[base + 3] !== 0
    });
  });
  return Object.freeze({
    directionalIndices: Object.freeze([...input.directionalIndices.slice(0, directionalCount)]),
    headers: Object.freeze(headers),
    lightIndices: Object.freeze([...input.lightIndices.slice(0, indexCount)]),
    overflowed: (flagsAndDirectionalCount & 0xc000_0000) !== 0
  });
}

function writeFloat(words: Uint32Array, index: number, value: number): void {
  new DataView(words.buffer).setFloat32(index * 4, value, true);
}

function validateCapacity(capacity: CpuLightListCapacity): void {
  for (const [name, value] of Object.entries(capacity)) assertUint32(value, `Light-list ${name}`);
}

function validateReceiver(receiver: LightReceiver, previous: LightReceiver | undefined): void {
  assertUint32(receiver.renderEntity, 'Light-list receiver entity');
  if (previous?.renderEntity === receiver.renderEntity)
    throw new Error(`Duplicate light receiver entity ${receiver.renderEntity}.`);
  assertUint32(receiver.layerMask, 'Light-list receiver layer mask');
  const values =
    receiver.bounds.kind === 'sphere'
      ? [...receiver.bounds.center, receiver.bounds.radius]
      : [...receiver.bounds.min, ...receiver.bounds.max];
  if (
    !values.every(Number.isFinite) ||
    (receiver.bounds.kind === 'sphere' && receiver.bounds.radius < 0)
  )
    throw new Error('Light-list receiver bounds must contain finite values.');
  if (receiver.bounds.kind === 'aabb') {
    const bounds = receiver.bounds;
    if (bounds.min.some((value, axis) => value > bounds.max[axis]!))
      throw new Error('Light-list receiver AABB bounds must be ordered.');
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new Error(`${label} must be an unsigned 32-bit integer.`);
}

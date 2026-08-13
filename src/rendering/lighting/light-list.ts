import type { WorldBounds } from '../visibility';
import { orderLightsForGpu } from './light';
import type {
  CpuLightListCapacity,
  CpuLightListHeader,
  CpuLightListResult,
  LightReceiver,
  PreparedLight
} from './types';

export function buildCpuLightLists(input: {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
  readonly capacity: CpuLightListCapacity;
}): CpuLightListResult {
  validateCapacity(input.capacity);
  validateUint32(input.viewLayerMask, 'viewLayerMask');
  const orderedLights = orderLightsForGpu(input.lights);
  const receivers = [...input.receivers].sort(
    (left, right) => left.renderEntity - right.renderEntity
  );
  for (let index = 0; index < receivers.length; index++) {
    validateReceiver(receivers[index]!);
    if (index > 0 && receivers[index - 1]!.renderEntity === receivers[index]!.renderEntity) {
      throw new Error(`Duplicate light receiver entity ${receivers[index]!.renderEntity}.`);
    }
  }
  const directional: number[] = [];
  const local: Readonly<{
    light: Exclude<PreparedLight, { readonly kind: 'directional' }>;
    index: number;
  }>[] = [];
  let disabledLights = 0;
  let layerRejectedLights = 0;
  let directionalTruncated = 0;
  for (let index = 0; index < orderedLights.length; index++) {
    const light = orderedLights[index]!;
    if (!light.enabled) {
      disabledLights++;
      continue;
    }
    if ((light.layerMask & input.viewLayerMask) === 0) {
      layerRejectedLights++;
      continue;
    }
    if (light.kind === 'directional') {
      if (directional.length < input.capacity.maxDirectionalLights) directional.push(index);
      else directionalTruncated++;
    } else {
      local.push({ light, index });
    }
  }

  const headers: CpuLightListHeader[] = [];
  const lightIndices: number[] = [];
  let disabledReceivers = 0;
  let layerRejectedReceivers = 0;
  let candidatePairs = 0;
  let intersectionTests = 0;
  let overflowedReceivers = 0;
  let truncatedIndices = 0;
  for (const receiver of receivers) {
    if (receiver.enabled === false) {
      disabledReceivers++;
      continue;
    }
    if ((receiver.layerMask & input.viewLayerMask) === 0) {
      layerRejectedReceivers++;
      continue;
    }
    const offset = lightIndices.length;
    let count = 0;
    let overflowed = false;
    for (const candidate of local) {
      if ((candidate.light.layerMask & receiver.layerMask) === 0) continue;
      candidatePairs++;
      intersectionTests++;
      if (!lightInfluencesBounds(candidate.light, receiver.bounds)) continue;
      if (
        count >= input.capacity.maxLightsPerReceiver ||
        lightIndices.length >= input.capacity.maxLightIndices
      ) {
        overflowed = true;
        truncatedIndices++;
        continue;
      }
      lightIndices.push(candidate.index);
      count++;
    }
    if (overflowed) overflowedReceivers++;
    headers.push(Object.freeze({ receiver: receiver.renderEntity, offset, count, overflowed }));
  }
  const overflowed = directionalTruncated > 0 || overflowedReceivers > 0;
  return Object.freeze({
    source: 'cpu-list',
    fallback: overflowed ? 'deterministic-truncate' : 'none',
    orderedLights,
    globalDirectionalLightIndices: Object.freeze(directional),
    headers: Object.freeze(headers),
    lightIndices: Object.freeze(lightIndices),
    capacity: Object.freeze({ ...input.capacity }),
    overflowed,
    counters: Object.freeze({
      inputLights: input.lights.length,
      inputReceivers: input.receivers.length,
      disabledLights,
      layerRejectedLights,
      disabledReceivers,
      layerRejectedReceivers,
      candidatePairs,
      intersectionTests,
      directionalCount: directional.length,
      directionalTruncated,
      emittedIndices: lightIndices.length,
      overflowedReceivers,
      truncatedIndices
    })
  });
}

function lightInfluencesBounds(
  light: Exclude<PreparedLight, { readonly kind: 'directional' }>,
  bounds: WorldBounds
): boolean {
  const center = light.position;
  const radius = light.range;
  if (bounds.kind === 'sphere') {
    const distance = Math.hypot(
      center[0] - bounds.center[0],
      center[1] - bounds.center[1],
      center[2] - bounds.center[2]
    );
    return distance <= radius + bounds.radius;
  }
  const closestX = Math.max(bounds.min[0], Math.min(center[0], bounds.max[0]));
  const closestY = Math.max(bounds.min[1], Math.min(center[1], bounds.max[1]));
  const closestZ = Math.max(bounds.min[2], Math.min(center[2], bounds.max[2]));
  const dx = center[0] - closestX;
  const dy = center[1] - closestY;
  const dz = center[2] - closestZ;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function validateCapacity(capacity: CpuLightListCapacity): void {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CPU light-list ${name} must be a non-negative integer.`);
    }
  }
}

function validateReceiver(receiver: LightReceiver): void {
  if (!Number.isSafeInteger(receiver.renderEntity) || receiver.renderEntity < 0) {
    throw new Error('Light receiver entity must be a non-negative integer.');
  }
  validateUint32(receiver.layerMask, 'receiver layerMask');
  const bounds = receiver.bounds;
  if (bounds.kind === 'sphere') {
    if (!finiteVec3(bounds.center) || !Number.isFinite(bounds.radius) || bounds.radius < 0) {
      throw new Error('Light receiver sphere must be finite with a non-negative radius.');
    }
  } else if (
    !finiteVec3(bounds.min) ||
    !finiteVec3(bounds.max) ||
    bounds.min.some((value, axis) => value > bounds.max[axis]!)
  ) {
    throw new Error('Light receiver AABB must be finite and ordered.');
  }
}

function finiteVec3(value: readonly number[]): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}

function validateUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`CPU light-list ${name} must be an unsigned 32-bit integer.`);
  }
}

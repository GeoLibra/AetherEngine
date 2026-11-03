import type { PreparedLight, ShadowRequest } from '../types';
import { buildLocalShadowCasterViews } from './local-shadow-casters';

export interface LocalShadowReceiverRecord {
  readonly lightIndex: number;
  readonly kind: 'spot' | 'point';
  /** Spot layer or first of the six canonical point cube layers. */
  readonly baseLayer: number;
  /** Spot matrix only; point receivers select a cube face from world-space direction. */
  readonly viewProjection?: readonly number[];
  readonly near: number;
  readonly far: number;
}

export const LOCAL_SHADOW_RECEIVER_MAX_RECORDS = 16;
export const LOCAL_SHADOW_RECEIVER_HEADER_WORDS = 4;
export const LOCAL_SHADOW_RECEIVER_RECORD_WORDS = 20;

/**
 * Packs receiver records into a fixed-size uniform ABI. Header word 0 is record count; each
 * record is `lightIndex, kind(spot=0|point=1), baseLayer, reserved`, followed by near/far in
 * the first two words of a 16-word matrix payload. Spot stores its matrix in all sixteen words;
 * point leaves the matrix identity and consumes near/far for radial depth reconstruction.
 */
export function packLocalShadowReceiverUniform(
  records: readonly LocalShadowReceiverRecord[],
  maxRecords = LOCAL_SHADOW_RECEIVER_MAX_RECORDS
): Uint32Array {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    throw new Error('Local shadow receiver maxRecords must be a non-negative integer.');
  }
  if (records.length > maxRecords)
    throw new Error('Local shadow receiver records exceed uniform capacity.');
  const words = new Uint32Array(
    LOCAL_SHADOW_RECEIVER_HEADER_WORDS + maxRecords * LOCAL_SHADOW_RECEIVER_RECORD_WORDS
  );
  words[0] = records.length;
  const floats = new Float32Array(words.buffer);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const base = LOCAL_SHADOW_RECEIVER_HEADER_WORDS + index * LOCAL_SHADOW_RECEIVER_RECORD_WORDS;
    words[base] = record.lightIndex;
    words[base + 1] = record.kind === 'spot' ? 0 : 1;
    words[base + 2] = record.baseLayer;
    if (
      !Number.isFinite(record.near) ||
      !Number.isFinite(record.far) ||
      record.near <= 0 ||
      record.far <= record.near
    ) {
      throw new Error('Local shadow receiver near/far must be finite and ordered.');
    }
    floats[base + 4] = record.near;
    floats[base + 5] = record.far;
    if (record.kind === 'spot') {
      if (
        record.viewProjection?.length !== 16 ||
        record.viewProjection.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          'Spot shadow receiver requires a finite sixteen-value view-projection matrix.'
        );
      }
      for (let word = 0; word < 16; word++) floats[base + 4 + word] = record.viewProjection[word]!;
    } else {
      floats[base + 6] = 1;
      floats[base + 11] = 1;
      floats[base + 16] = 1;
      floats[base + 19] = 1;
    }
  }
  return words;
}

/**
 * Resolves graph depth-array layers into an explicit forward-receiver table. `firstLayer` is
 * normally four because directional CSM owns layers 0..3. Accepted request order is preserved,
 * so atlas/request budgeting cannot silently desynchronize caster and receiver layers.
 */
export function buildLocalShadowReceiverLayout(input: {
  readonly requests: readonly ShadowRequest[];
  readonly lights: readonly PreparedLight[];
  readonly firstLayer: number;
}): readonly LocalShadowReceiverRecord[] {
  if (!Number.isSafeInteger(input.firstLayer) || input.firstLayer < 0) {
    throw new Error('Local shadow receiver firstLayer must be a non-negative integer.');
  }
  const orderedLights = [...input.lights].sort((left, right) => left.entity - right.entity);
  const indexByEntity = new Map(orderedLights.map((light, index) => [light.entity, index]));
  const casterViews = buildLocalShadowCasterViews({
    requests: input.requests,
    lights: orderedLights
  });
  const records: LocalShadowReceiverRecord[] = [];
  let layer = input.firstLayer;
  for (let cursor = 0; cursor < casterViews.length;) {
    const caster = casterViews[cursor]!;
    const light = orderedLights.find(
      (candidate) => candidate.entity === caster.request.lightEntity
    );
    const lightIndex = indexByEntity.get(caster.request.lightEntity);
    if (light === undefined || lightIndex === undefined || light.kind === 'directional') {
      throw new Error('Local shadow receiver light index is missing.');
    }
    if (caster.request.kind === 'spot') {
      records.push(
        Object.freeze({
          lightIndex,
          kind: 'spot',
          baseLayer: layer++,
          viewProjection: caster.viewProjection,
          near: light.range * 1e-4,
          far: light.range
        })
      );
      cursor++;
      continue;
    }
    if (caster.request.kind !== 'point-face' || caster.request.subresourceIndex !== 0) {
      throw new Error('Point shadow receiver requests must begin at canonical face 0.');
    }
    const faces = casterViews.slice(cursor, cursor + 6);
    if (
      faces.length !== 6 ||
      faces.some(
        (face, index) =>
          face.request.kind !== 'point-face' ||
          face.request.lightEntity !== light.entity ||
          face.request.subresourceIndex !== index
      )
    ) {
      throw new Error('Point shadow receiver requires six contiguous canonical face requests.');
    }
    records.push(
      Object.freeze({
        lightIndex,
        kind: 'point',
        baseLayer: layer,
        near: light.range * 1e-4,
        far: light.range
      })
    );
    layer += 6;
    cursor += 6;
  }
  return Object.freeze(records);
}

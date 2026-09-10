import { evaluateCookTorranceDirect } from '../../src/rendering/lighting';

export interface PbrEvaluationObservation {
  readonly evaluations: number;
  readonly checksum: string;
}

/** Runs a deterministic spread of material and angular inputs through the production PBR oracle. */
export function runPbrEvaluationWorkload(count: number): PbrEvaluationObservation {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('PBR evaluation count must be a positive integer.');
  }
  const sums: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < count; index++) {
    const viewAngle = ((index + 0.5) / count) * 1.4;
    const lightAngle = ((((index * 17) % count) + 0.5) / count) * 1.4;
    const value = evaluateCookTorranceDirect({
      baseColorLinear: [0.2 + 0.6 * ((index % 7) / 6), 0.35, 0.7],
      metallic: (index % 3) / 2,
      roughness: (index % 5) / 4,
      normal: [0, 0, 1],
      viewDirection: [Math.sin(viewAngle), 0, Math.cos(viewAngle)],
      lightDirection: [0, Math.sin(lightAngle), Math.cos(lightAngle)],
      lightRadianceLinear: [1, 0.8, 0.6]
    });
    sums[0] += value[0];
    sums[1] += value[1];
    sums[2] += value[2];
  }
  return Object.freeze({
    evaluations: count,
    checksum: textChecksum(sums.map((value) => value.toFixed(3)).join(':'))
  });
}

function textChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

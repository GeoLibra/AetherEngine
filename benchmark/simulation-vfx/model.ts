export const VFX_SIMULATION_TICK_RATE = 60;

export interface SimulationVFXSpawnRecord {
  readonly id: number;
  readonly seed: number;
  readonly spawnTick: number;
  readonly lifetime: number;
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly baseSize: number;
  readonly colorRgba: readonly [number, number, number, number];
}

export interface SimulationVFXOracleResult {
  readonly unspawnedCount: number;
  readonly activeCount: number;
  readonly deadCount: number;
  readonly stateChecksum: number;
  readonly aliveIds: readonly number[];
}

export function createVFXSpawnBatch(
  count: number,
  seed: number
): readonly SimulationVFXSpawnRecord[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };

  const records: SimulationVFXSpawnRecord[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const itemSeed = next();
    const spawnTick = next() % 60; // 0 to 59 ticks (0.0s to ~0.983s)
    const lifetime = 1.0 + (next() % 2000) / 1000; // 1.0 - 3.0s
    records.push(
      Object.freeze({
        id,
        seed: itemSeed,
        spawnTick,
        lifetime,
        position: [
          ((next() % 2000) - 1000) / 100,
          ((next() % 2000) - 1000) / 100,
          ((next() % 2000) - 1000) / 100
        ] as const,
        velocity: [
          ((next() % 1000) - 500) / 100,
          ((next() % 1000) - 500) / 100,
          ((next() % 1000) - 500) / 100
        ] as const,
        baseSize: 0.1 + (next() % 100) / 100,
        colorRgba: [(next() % 255) / 255, (next() % 255) / 255, (next() % 255) / 255, 1.0] as const
      })
    );
  }
  return Object.freeze(records);
}

/**
 * Independent scalar reference implementation.
 * Strictly respects particle spawnTick (converted to seconds via 60Hz tick rate),
 * unspawned, active, and dead lifecycle boundaries.
 */
export function evaluateVFXReferenceScalar(
  records: readonly SimulationVFXSpawnRecord[],
  elapsedTime: number
): SimulationVFXOracleResult {
  let unspawnedCount = 0;
  let activeCount = 0;
  let deadCount = 0;
  let checksum = 0;
  const aliveIds: number[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const spawnTime = r.spawnTick / VFX_SIMULATION_TICK_RATE;
    if (elapsedTime < spawnTime) {
      unspawnedCount++;
      continue;
    }
    const deathTime = spawnTime + r.lifetime;
    if (elapsedTime >= deathTime) {
      deadCount++;
      continue;
    }
    activeCount++;
    aliveIds.push(r.id);

    const age = elapsedTime - spawnTime;
    const normalizedAge = age / r.lifetime;
    const px = r.position[0] + r.velocity[0] * age;
    const py = r.position[1] + r.velocity[1] * age;
    const pz = r.position[2] + r.velocity[2] * age;
    const sz = r.baseSize * (1.0 - normalizedAge);
    const op = 1.0 - normalizedAge;
    const colorContrib = r.colorRgba[0] * 10 + r.colorRgba[1] * 20 + r.colorRgba[2] * 30;

    const term = Math.floor(
      px * 100 + py * 100 + pz * 100 + sz * 100 + op * 100 + colorContrib + (r.seed % 100)
    );
    checksum = (checksum + term) | 0;
  }

  return Object.freeze({
    unspawnedCount,
    activeCount,
    deadCount,
    stateChecksum: checksum,
    aliveIds: Object.freeze(aliveIds)
  });
}

/**
 * Subject: Vertex analytic raw baseline under benchmark.
 */
export function evaluateVertexAnalyticVFX(
  records: readonly SimulationVFXSpawnRecord[],
  elapsedTime: number
): SimulationVFXOracleResult {
  let unspawnedCount = 0;
  let activeCount = 0;
  let deadCount = 0;
  let checksum = 0;
  const aliveIds: number[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const spawnTime = record.spawnTick * (1 / 60);
    if (elapsedTime < spawnTime) {
      unspawnedCount++;
      continue;
    }
    const deathTime = spawnTime + record.lifetime;
    if (elapsedTime >= deathTime) {
      deadCount++;
      continue;
    }
    activeCount++;
    aliveIds.push(record.id);

    const age = elapsedTime - spawnTime;
    const normalizedAge = age / record.lifetime;
    const posX = record.position[0] + record.velocity[0] * age;
    const posY = record.position[1] + record.velocity[1] * age;
    const posZ = record.position[2] + record.velocity[2] * age;
    const size = record.baseSize * (1.0 - normalizedAge);
    const opacity = 1.0 - normalizedAge;
    const colorContrib =
      record.colorRgba[0] * 10 + record.colorRgba[1] * 20 + record.colorRgba[2] * 30;

    checksum =
      (checksum +
        Math.floor(
          posX * 100 +
            posY * 100 +
            posZ * 100 +
            size * 100 +
            opacity * 100 +
            colorContrib +
            (record.seed % 100)
        )) |
      0;
  }

  return Object.freeze({
    unspawnedCount,
    activeCount,
    deadCount,
    stateChecksum: checksum,
    aliveIds: Object.freeze(aliveIds)
  });
}

/**
 * Deterministic Golden Checksum for 1,000 particles with seed 0x1337 at dt = 0.5s.
 */
export const VFX_GOLDEN_1000_SEED_1337_DT_05 = Object.freeze({
  unspawnedCount: 469,
  activeCount: 531,
  deadCount: 0,
  stateChecksum: 154801
});

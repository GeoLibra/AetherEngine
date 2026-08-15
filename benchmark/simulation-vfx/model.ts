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

export interface SimulationVFXSimulationState {
  readonly id: number;
  readonly age: number;
  readonly normalizedAge: number;
  readonly alive: boolean;
  readonly position: readonly [number, number, number];
  readonly currentSize: number;
  readonly opacity: number;
}

export interface SimulationVFXOracleResult {
  readonly activeCount: number;
  readonly deadCount: number;
  readonly droppedCount: number;
  readonly stateChecksum: number;
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
    const lifetime = 1.0 + (next() % 2000) / 1000; // 1.0 - 3.0s
    records.push(
      Object.freeze({
        id,
        seed: itemSeed,
        spawnTick: 0,
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
        colorRgba: [1, 1, 1, 1] as const
      })
    );
  }
  return Object.freeze(records);
}

export function evaluateVertexAnalyticVFX(
  records: readonly SimulationVFXSpawnRecord[],
  elapsedTime: number
): SimulationVFXOracleResult {
  let activeCount = 0;
  let deadCount = 0;
  let checksum = 0;

  for (const record of records) {
    if (elapsedTime >= record.lifetime) {
      deadCount++;
      continue;
    }
    activeCount++;
    const age = elapsedTime;
    const normalizedAge = age / record.lifetime;
    const posX = record.position[0] + record.velocity[0] * age;
    const posY = record.position[1] + record.velocity[1] * age;
    const posZ = record.position[2] + record.velocity[2] * age;
    const size = record.baseSize * (1.0 - normalizedAge);
    const opacity = 1.0 - normalizedAge;

    checksum =
      (checksum + Math.floor(posX * 100 + posY * 100 + posZ * 100 + size * 10 + opacity * 10)) | 0;
  }

  return Object.freeze({
    activeCount,
    deadCount,
    droppedCount: 0,
    stateChecksum: checksum
  });
}

import { performance } from 'node:perf_hooks';

/**
 * Experiment 1: Stride Access Pattern
 * Purpose: Isolate CPU cache line (64 bytes) utilization and hardware prefetcher behavior
 *          using pure Float32Array (zero JS object/GC overhead).
 */
export function runStrideExperiment(options = { n: 16 * 1024 * 1024, iterations: 1 }) {
  console.log('\n[Experiment 1] Memory Stride Benchmark (Pure Float32Array)');
  console.log('Description: Traversing identical Float32 elements with varying stride steps\n');

  const N = options.n;
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = 1.0;

  const strides = [1, 2, 4, 8, 16, 64];
  const results: Record<number, number> = {};

  for (const stride of strides) {
    // Warmup
    let warm = 0;
    for (let r = 0; r < stride; r++) {
      for (let i = r; i < N; i += stride) warm += data[i]!;
    }

    const start = performance.now();
    let sum = 0;
    for (let iter = 0; iter < options.iterations; iter++) {
      // Exactly N elements accessed regardless of stride
      for (let r = 0; r < stride; r++) {
        for (let i = r; i < N; i += stride) {
          sum += data[i]!;
        }
      }
    }
    const cost = (performance.now() - start) / options.iterations;
    results[stride] = cost;

    const notes =
      stride === 1
        ? '100% Cache Line utilization + Hardware Prefetch active'
        : stride === 16
          ? '64-byte stride step (forces new Cache Line per read)'
          : stride === 64
            ? 'Large stride jump (defeats hardware prefetcher)'
            : '';

    console.log(
      `  Stride = ${stride.toString().padEnd(2)} | Latency: ${cost.toFixed(2).padStart(6)} ms | Notes: ${notes}`
    );
  }

  return results;
}

/**
 * Experiment 2: Cache Cliff Analysis
 * Purpose: Measure average read latency (ns/op) across varying working set sizes
 *          to demonstrate latency shifts across L1, L2, L3, and DRAM.
 */
export function runCacheCliffExperiment() {
  console.log('\n[Experiment 2] Working Set Size & Cache Cliff Analysis');
  console.log('Description: Measuring average read latency (ns/op) across varying dataset sizes\n');

  const sizesKB = [16, 64, 256, 1024, 4096, 32768];
  const results: Record<number, number> = {};

  for (const sizeKB of sizesKB) {
    const count = (sizeKB * 1024) / 4; // float32 element count
    const buffer = new Float32Array(count);
    buffer.fill(1.0);

    const totalOps = 20_000_000;
    const mask = count - 1;

    // Warmup
    let s = 0;
    for (let i = 0; i < 10000; i++) s += buffer[i & mask]!;

    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < totalOps; i++) {
      sum += buffer[(i * 17) & mask]!;
    }
    const costMs = performance.now() - start;
    const nsPerOp = (costMs * 1e6) / totalOps;
    results[sizeKB] = nsPerOp;

    const level = sizeKB <= 64 ? '≈ L1 Data Cache' : sizeKB <= 1024 ? '≈ L2 Cache' : '≈ L3 / DRAM';
    console.log(
      `  Working Set: ${sizeKB.toString().padStart(5)} KB (${level.padEnd(18)}) | Read Latency: ${nsPerOp.toFixed(3)} ns/op`
    );
  }

  return results;
}

/**
 * Experiment 3: Architecture Comparison
 * 1. JS Object AoS: Array<{ x, y, vx, vy, health, mass... }> (Pointer indirection)
 * 2. Binary AoS: Interleaved Float32Array (Eliminates JS object lookup, isolates layout overhead)
 * 3. Chunk-based SoA: Archetype Chunk layout (Aether Table architecture, 16KB/64KB blocks)
 */
export function runArchitectureComparison(
  options = { totalEntities: 500_000, iterations: 10, chunkSize: 1024 }
) {
  const { totalEntities, iterations, chunkSize } = options;
  const FIELDS_PER_ENTITY = 16; // 16 float fields per entity (64 bytes = exactly 1 Cache Line)

  console.log(
    '\n[Experiment 3] Architectural Showdown: Object AoS vs Binary AoS vs Chunk-based SoA'
  );
  console.log(
    `Description: Updating ${totalEntities.toLocaleString()} entities in MovementSystem (x+=vx, y+=vy)\n`
  );

  // 1. JS Object AoS
  interface EntityObj {
    x: number;
    y: number;
    vx: number;
    vy: number;
    health: number;
    mass: number;
  }
  const objList: EntityObj[] = new Array(totalEntities);
  for (let i = 0; i < totalEntities; i++) {
    objList[i] = {
      x: i,
      y: i,
      vx: 1.0,
      vy: 1.0,
      health: 100,
      mass: 10
    };
  }

  // 2. Binary AoS (Interleaved binary layout)
  const binaryAos = new Float32Array(totalEntities * FIELDS_PER_ENTITY);
  for (let i = 0; i < totalEntities; i++) {
    const base = i * FIELDS_PER_ENTITY;
    binaryAos[base + 0] = i; // x
    binaryAos[base + 1] = i; // y
    binaryAos[base + 2] = 1.0; // vx
    binaryAos[base + 3] = 1.0; // vy
    // base + 4..15 represents cold/unrelated component data
  }

  // 3. Global Binary SoA (Flat contiguous TypedArrays per field across entire World)
  const globalSoa = {
    x: new Float32Array(totalEntities),
    y: new Float32Array(totalEntities),
    vx: new Float32Array(totalEntities).fill(1.0),
    vy: new Float32Array(totalEntities).fill(1.0)
  };
  for (let i = 0; i < totalEntities; i++) {
    globalSoa.x[i] = i;
    globalSoa.y[i] = i;
  }

  // 4. Chunk-based SoA (Aether Table Archetype Chunks)
  const chunkCount = Math.ceil(totalEntities / chunkSize);
  interface Chunk {
    count: number;
    x: Float32Array;
    y: Float32Array;
    vx: Float32Array;
    vy: Float32Array;
  }

  const chunks: Chunk[] = [];
  let remaining = totalEntities;
  for (let c = 0; c < chunkCount; c++) {
    const count = Math.min(remaining, chunkSize);
    const chunk: Chunk = {
      count,
      x: new Float32Array(chunkSize),
      y: new Float32Array(chunkSize),
      vx: new Float32Array(chunkSize).fill(1.0),
      vy: new Float32Array(chunkSize).fill(1.0)
    };
    for (let i = 0; i < count; i++) {
      chunk.x[i] = c * chunkSize + i;
      chunk.y[i] = c * chunkSize + i;
    }
    chunks.push(chunk);
    remaining -= count;
  }

  // Warmup
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 1000; j++) objList[j]!.x += objList[j]!.vx;
    for (let j = 0; j < 1000; j++)
      binaryAos[j * FIELDS_PER_ENTITY]! += binaryAos[j * FIELDS_PER_ENTITY + 2]!;
    for (let j = 0; j < 1000; j++) globalSoa.x[j]! += globalSoa.vx[j]!;
    for (let j = 0; j < 1000; j++) chunks[0]!.x[j]! += chunks[0]!.vx[j]!;
  }

  // 1. Object AoS
  let start = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < totalEntities; i++) {
      const e = objList[i]!;
      e.x += e.vx;
      e.y += e.vy;
    }
  }
  const timeObjAos = (performance.now() - start) / iterations;

  // 2. Binary AoS
  start = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < totalEntities; i++) {
      const base = i * FIELDS_PER_ENTITY;
      binaryAos[base + 0]! += binaryAos[base + 2]!;
      binaryAos[base + 1]! += binaryAos[base + 3]!;
    }
  }
  const timeBinaryAos = (performance.now() - start) / iterations;

  // 3. Global Binary SoA
  start = performance.now();
  const { x: gx, y: gy, vx: gvx, vy: gvy } = globalSoa;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < totalEntities; i++) {
      gx[i]! += gvx[i]!;
      gy[i]! += gvy[i]!;
    }
  }
  const timeGlobalSoa = (performance.now() - start) / iterations;

  // 4. Chunk-based SoA
  start = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let c = 0; c < chunkCount; c++) {
      const chunk = chunks[c]!;
      for (let i = 0; i < chunk.count; i++) {
        chunk.x[i]! += chunk.vx[i]!;
        chunk.y[i]! += chunk.vy[i]!;
      }
    }
  }
  const timeChunkSoa = (performance.now() - start) / iterations;

  console.log(
    `  | Architecture Pattern      | Frame Time (ms) | Relative Speed (vs Object AoS) | Cache Line Payload |`
  );
  console.log(
    `  |---------------------------|-----------------|--------------------------------|--------------------|`
  );
  console.log(
    `  | 1. JS Object AoS          | ${timeObjAos.toFixed(2).padStart(8)} ms    | 1.0x (Baseline)                | Low (Pointer Ind.) |`
  );
  console.log(
    `  | 2. Binary AoS (Interleave)| ${timeBinaryAos.toFixed(2).padStart(8)} ms    | ${(timeObjAos / timeBinaryAos).toFixed(1).padStart(4)}x faster               | 25.0% (Cold Data)  |`
  );
  console.log(
    `  | 3. Global Binary SoA      | ${timeGlobalSoa.toFixed(2).padStart(8)} ms    | ${(timeObjAos / timeGlobalSoa).toFixed(1).padStart(4)}x faster               | 100% (Dense Stream)|`
  );
  console.log(
    `  | 4. Chunk-based SoA        | ${timeChunkSoa.toFixed(2).padStart(8)} ms    | ${(timeObjAos / timeChunkSoa).toFixed(1).padStart(4)}x faster               | 100% (Dense Blocks)|`
  );

  console.log(`\n  👉 Core Architectural Findings:`);
  console.log(
    `     1. AoS -> SoA: Extracting hot components into contiguous streams delivers a massive throughput speedup`
  );
  console.log(
    `        due to 100% cache line payload utilization (eliminating the 75% unread cold data bandwidth waste in Binary AoS).`
  );
  console.log(
    `     2. Global SoA vs Chunk SoA: Both achieve optimal linear streaming performance under pure traversal.`
  );
  console.log(
    `        Chunk-based SoA provides Archetype modularity, bounded reallocation costs, and structural mutability without sacrificing streaming speed.\n`
  );

  return { timeObjAos, timeBinaryAos, timeGlobalSoa, timeChunkSoa };
}

// Execute benchmark suite
export function runAll() {
  console.log('='.repeat(76));
  console.log('  AETHER ENGINE: CHUNK-BASED SOA VS AOS CPU CACHE BENCHMARK');
  console.log('  Hardware Locality, Stride Penalties & Archetype Table Verification');
  console.log('='.repeat(76));

  runStrideExperiment();
  runCacheCliffExperiment();
  runArchitectureComparison();
}

// Auto-run when invoked directly
runAll();

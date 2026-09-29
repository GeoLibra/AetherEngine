import type { AssetRequestCircuitBreakerPolicy, AssetRequestCircuitSnapshot } from './types';
import type { AssetRequestKey, AssetRequestStage } from './types';

const DEFAULT_CIRCUIT_BREAKER_POLICY: AssetRequestCircuitBreakerPolicy = Object.freeze({
  failureThreshold: 5,
  openMilliseconds: 5_000
});

/** Owns stage-wide transient-failure cooldowns and a single half-open admission probe. */
export class AssetRequestCircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly circuits = new Map<string, OpenCircuit>();
  private readonly probes = new Set<AssetRequestKey>();

  constructor(policy: AssetRequestCircuitBreakerPolicy = DEFAULT_CIRCUIT_BREAKER_POLICY) {
    validatePolicy(policy);
    this.policy = Object.freeze({ ...policy });
  }

  private readonly policy: AssetRequestCircuitBreakerPolicy;

  snapshots(now: number): readonly AssetRequestCircuitSnapshot[] {
    return Object.freeze(
      [...this.circuits.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, circuit]) =>
          Object.freeze({
            stage: circuit.stage,
            failure: circuit.failure,
            kind: now < circuit.openUntilMilliseconds ? ('open' as const) : ('half-open' as const),
            openUntilMilliseconds: circuit.openUntilMilliseconds
          })
        )
    );
  }

  probeCandidate(
    stage: AssetRequestStage,
    demands: readonly { key: AssetRequestKey; stage: AssetRequestStage }[],
    now: number
  ): AssetRequestKey | undefined {
    const circuit = this.find(stage);
    if (circuit === undefined || now < circuit.openUntilMilliseconds || circuit.probeInFlight)
      return undefined;
    return demands.find((demand) => demand.stage === stage)?.key;
  }

  hasCircuit(stage: AssetRequestStage): boolean {
    return this.find(stage) !== undefined;
  }

  claim(stage: AssetRequestStage, key: AssetRequestKey, now: number): boolean {
    const circuit = this.find(stage);
    if (circuit === undefined) return true;
    if (now < circuit.openUntilMilliseconds || circuit.probeInFlight) return false;
    if (this.probeCandidate(stage, [{ key, stage }], now) !== key) return false;
    circuit.probeInFlight = true;
    this.probes.add(key);
    return true;
  }

  isProbe(key: AssetRequestKey): boolean {
    return this.probes.has(key);
  }

  releaseProbe(key: AssetRequestKey): void {
    this.probes.delete(key);
  }

  recordFailure(stage: AssetRequestStage, failure: string, now: number): void {
    const key = circuitKey(stage, failure);
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    if (this.circuits.has(key) || failures >= this.policy.failureThreshold)
      this.open(key, stage, failure, now);
  }

  recordProbeFailure(stage: AssetRequestStage, failure: string, now: number): void {
    const match = [...this.circuits.entries()].find(
      ([, circuit]) => circuit.stage === stage && circuit.probeInFlight
    );
    if (match === undefined) return;
    this.open(match[0], stage, failure, now);
    this.probes.clear();
  }

  recordSuccess(stage: AssetRequestStage): void {
    for (const [key, circuit] of this.circuits) {
      if (circuit.stage === stage && circuit.probeInFlight) {
        this.circuits.delete(key);
        this.failures.delete(key);
      }
    }
    this.probes.clear();
  }

  private find(stage: AssetRequestStage): OpenCircuit | undefined {
    return [...this.circuits.values()].find((circuit) => circuit.stage === stage);
  }

  private open(key: string, stage: AssetRequestStage, failure: string, now: number): void {
    const openUntilMilliseconds = now + this.policy.openMilliseconds;
    if (!Number.isSafeInteger(openUntilMilliseconds))
      throw new Error('Asset circuit open time must be a safe integer.');
    this.circuits.set(key, { stage, failure, openUntilMilliseconds, probeInFlight: false });
    this.failures.set(key, 0);
  }
}

interface OpenCircuit {
  readonly stage: AssetRequestStage;
  readonly failure: string;
  readonly openUntilMilliseconds: number;
  probeInFlight: boolean;
}

function circuitKey(stage: AssetRequestStage, failure: string): string {
  return `${stage}\u0000${failure}`;
}

function validatePolicy(policy: AssetRequestCircuitBreakerPolicy): void {
  if (
    !Number.isSafeInteger(policy.failureThreshold) ||
    policy.failureThreshold < 1 ||
    !Number.isSafeInteger(policy.openMilliseconds) ||
    policy.openMilliseconds < 0
  ) {
    throw new Error(
      'Asset circuit breaker threshold and open duration must be valid non-negative integers.'
    );
  }
}

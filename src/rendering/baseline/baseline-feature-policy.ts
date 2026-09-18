import {
  BuiltInFeature,
  BuiltInFeatureImplementation,
  BuiltInHostService,
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES,
  LIGHT_LIST_SHADER_MAX_LIGHTS,
  LIGHT_LIST_SHADER_MAX_RECEIVERS,
  createCpuBoundedLightListImplementation,
  createWebGlFragmentLightListImplementation,
  createWebGpuComputeLightListImplementation,
  type CpuBoundedLightListFrameInput,
  type CpuLightListCapacity,
  type CpuLightListResult,
  type WebGlFragmentLightListBuildContext,
  type WebGpuLightListBuildContext
} from '../lighting';
import {
  FeaturePolicyCoordinator,
  ZERO_RESOURCE_BUDGET,
  resolveFeaturePolicy,
  type FeatureId,
  type FeatureImplementation,
  type FeaturePolicyInput,
  type FeaturePolicySnapshot,
  type PreparedFeaturePolicy,
  type RenderFeatureImplementation,
  type RuntimeFeatureImplementation
} from '../../feature-policy';
import type { RHIDevice } from '../../rhi/contracts';

/** Standard maximum capacity for baseline forward light-list construction. */
export const BASELINE_LIGHT_LIST_CAPACITY: CpuLightListCapacity = Object.freeze({
  maxDirectionalLights: 64,
  maxLightsPerReceiver: 16,
  maxLightIndices: 4096
});

/**
 * Validates that requested light-list capacity stays within the fixed built-in shader ABI maximums.
 * Fails fast at the policy resolution and preparation boundary.
 */
export function validateBaselineLightListCapacity(capacity: CpuLightListCapacity): void {
  if (capacity.maxDirectionalLights > LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS) {
    throw new RangeError(
      `Baseline light-list capacity maxDirectionalLights (${capacity.maxDirectionalLights}) exceeds shader ABI maximum (${LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS}).`
    );
  }
  if (capacity.maxLightIndices > LIGHT_LIST_SHADER_MAX_INDICES) {
    throw new RangeError(
      `Baseline light-list capacity maxLightIndices (${capacity.maxLightIndices}) exceeds shader ABI maximum (${LIGHT_LIST_SHADER_MAX_INDICES}).`
    );
  }
  if (capacity.maxLightsPerReceiver > LIGHT_LIST_SHADER_MAX_LIGHTS) {
    throw new RangeError(
      `Baseline light-list capacity maxLightsPerReceiver (${capacity.maxLightsPerReceiver}) exceeds shader ABI maximum (${LIGHT_LIST_SHADER_MAX_LIGHTS}).`
    );
  }
}

/** Input parameters for resolving FeaturePolicy in baseline rendering. */
export interface BaselineFeaturePolicyResolutionInput {
  readonly device: RHIDevice;
  readonly viewId?: string;
  readonly capacity?: CpuLightListCapacity;
  readonly maxTextureDimension2D?: number;
}

/** Constructs the canonical feature policy input for baseline standard-lit rendering. */
export function createBaselineFeaturePolicyInput(
  input: BaselineFeaturePolicyResolutionInput
): FeaturePolicyInput {
  const { device } = input;
  const capacity = input.capacity ?? BASELINE_LIGHT_LIST_CAPACITY;
  validateBaselineLightListCapacity(capacity);
  const maxTextureDimension2D =
    input.maxTextureDimension2D ?? device.capabilities.limits.maxTextureDimension2D ?? 2048;

  const gpuComputeImpl = createWebGpuComputeLightListImplementation({
    capacity,
    estimatedBudget: ZERO_RESOURCE_BUDGET
  });
  const webglFragmentImpl = createWebGlFragmentLightListImplementation({
    capacity,
    estimatedBudget: ZERO_RESOURCE_BUDGET,
    maxTextureDimension2D
  });
  const cpuBoundedImpl = createCpuBoundedLightListImplementation({
    capacity,
    estimatedBudget: ZERO_RESOURCE_BUDGET
  });

  const implementations: readonly FeatureImplementation[] = [
    gpuComputeImpl,
    webglFragmentImpl,
    cpuBoundedImpl
  ];

  return {
    schemaVersion: 1,
    revision: 1,
    profileId: `baseline-${input.viewId ?? 'main'}`,
    deviceGeneration: device.generation,
    capabilities: device.capabilities,
    hostServices: new Set([BuiltInHostService.MainCpu]),
    budget: ZERO_RESOURCE_BUDGET,
    requests: [
      {
        feature: BuiltInFeature.LightListBuild,
        semanticContract: 'aether.light-list-build@1',
        required: true,
        priority: 1
      }
    ],
    implementations
  };
}

export interface BaselinePreparedPolicySession {
  readonly policy: BaselinePreparedFeaturePolicy;
  readonly coordinator: FeaturePolicyCoordinator;
  dispose(): Promise<void>;
}

/**
 * Resolves and prepares the canonical FeaturePolicy for baseline forward rendering using the coordinator.
 * Returns a disposable handle owning the coordinator to prevent lease leaks.
 */
export async function prepareBaselineFeaturePolicy(
  input: BaselineFeaturePolicyResolutionInput
): Promise<BaselinePreparedPolicySession> {
  const policyInput = createBaselineFeaturePolicyInput(input);
  const coordinator = new FeaturePolicyCoordinator();
  const prepareResult = await coordinator.prepare(policyInput);
  if (!prepareResult.ok) {
    coordinator.destroy();
    throw new Error(
      `Baseline FeaturePolicy preparation failed: ${prepareResult.resolution.unsupportedRequired.join(', ')}`
    );
  }
  const publication = coordinator.publish();
  if (publication === undefined) {
    coordinator.destroy();
    throw new Error('Baseline FeaturePolicy publication failed.');
  }

  const decision = publication.current.snapshot.decisions.get(BuiltInFeature.LightListBuild);
  if (decision === undefined || decision.implementation === null) {
    coordinator.destroy();
    throw new Error('Baseline FeaturePolicy failed to select a LightListBuild implementation.');
  }
  const winner = policyInput.implementations.find(
    (candidate) => candidate.id === decision.implementation
  );
  if (winner === undefined) {
    coordinator.destroy();
    throw new Error(
      `Selected LightListBuild implementation "${decision.implementation}" not found in registry.`
    );
  }

  const policy: BaselinePreparedFeaturePolicy = {
    snapshot: publication.current.snapshot,
    prepared: publication.current.prepared,
    implementations: new Map([[BuiltInFeature.LightListBuild, winner]])
  };

  return {
    policy,
    coordinator,
    async dispose(): Promise<void> {
      coordinator.destroy();
    }
  };
}

/**
 * Synchronous resolver that evaluates capabilities against registered implementations.
 * Uses real resolution logic to determine the winning LightListBuild implementation.
 */
export function resolveBaselineFeaturePolicy(
  input: BaselineFeaturePolicyResolutionInput
): BaselinePreparedFeaturePolicy {
  const policyInput = createBaselineFeaturePolicyInput(input);
  const resolution = resolveFeaturePolicy(policyInput);
  if (!resolution.ok) {
    throw new Error(
      `Baseline FeaturePolicy resolution failed: ${resolution.unsupportedRequired.join(', ')}`
    );
  }

  const decision = resolution.snapshot.decisions.get(BuiltInFeature.LightListBuild);
  if (decision === undefined || decision.implementation === null) {
    throw new Error('Baseline FeaturePolicy failed to select a LightListBuild implementation.');
  }

  const winner = policyInput.implementations.find(
    (candidate) => candidate.id === decision.implementation
  );
  if (winner === undefined) {
    throw new Error(
      `Selected LightListBuild implementation "${decision.implementation}" not found in registry.`
    );
  }

  const capacity = input.capacity ?? BASELINE_LIGHT_LIST_CAPACITY;
  validateBaselineLightListCapacity(capacity);
  return {
    snapshot: resolution.snapshot,
    prepared: new Map([[BuiltInFeature.LightListBuild, capacity]]),
    implementations: new Map([[BuiltInFeature.LightListBuild, winner]])
  };
}

export interface BaselinePreparedFeaturePolicy extends PreparedFeaturePolicy {
  readonly implementations?: ReadonlyMap<FeatureId, FeatureImplementation>;
}

/**
 * Creates the matching FeatureImplementation for the selected LightListBuild decision.
 */
export function createBaselineLightListImplementation(
  implementationId: string,
  capacity: CpuLightListCapacity,
  maxTextureDimension2D: number
): BaselineLightListImplementation {
  validateBaselineLightListCapacity(capacity);
  if (implementationId === BuiltInFeatureImplementation.WebGpuComputeLightList) {
    return createWebGpuComputeLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    });
  }
  if (implementationId === BuiltInFeatureImplementation.WebGlFragmentLightList) {
    return createWebGlFragmentLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET,
      maxTextureDimension2D
    });
  }
  if (implementationId === BuiltInFeatureImplementation.CpuBoundedLightList) {
    return createCpuBoundedLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    });
  }
  throw new Error(`Unsupported baseline LightListBuild implementation: ${implementationId}`);
}

/**
 * Structural type guard checking whether an object satisfies the PreparedFeaturePolicy contract.
 * Accepts any object with a valid snapshot and a ReadonlyMap-compatible prepared container.
 */
export function isPreparedFeaturePolicy(value: unknown): value is PreparedFeaturePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'snapshot' in candidate &&
    isFeaturePolicySnapshot(candidate.snapshot) &&
    'prepared' in candidate &&
    typeof candidate.prepared === 'object' &&
    candidate.prepared !== null &&
    typeof (candidate.prepared as ReadonlyMap<FeatureId, unknown>).get === 'function' &&
    typeof (candidate.prepared as ReadonlyMap<FeatureId, unknown>).has === 'function'
  );
}

/**
 * Type guard checking whether an object satisfies the FeaturePolicySnapshot contract.
 */
export function isFeaturePolicySnapshot(value: unknown): value is FeaturePolicySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.hash === 'string' &&
    typeof candidate.revision === 'number' &&
    candidate.decisions !== null &&
    typeof candidate.decisions === 'object' &&
    typeof (candidate.decisions as ReadonlyMap<unknown, unknown>).get === 'function'
  );
}

export type BaselineLightListImplementation =
  | RenderFeatureImplementation<CpuLightListCapacity, WebGpuLightListBuildContext>
  | RenderFeatureImplementation<CpuLightListCapacity, WebGlFragmentLightListBuildContext>
  | RuntimeFeatureImplementation<
      CpuLightListCapacity,
      CpuBoundedLightListFrameInput,
      CpuLightListResult
    >;

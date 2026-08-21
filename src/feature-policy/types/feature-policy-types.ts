import type {
  DeviceCapabilities,
  FormatCapabilities,
  RHIFeature,
  RHIQueueRole,
  SupportStatus
} from '../../rhi/contracts/capability';
import type { GPUTextureFormat } from '../../rhi/contracts/webgpu';
import type { FeaturePolicyCacheDomain } from '../constants';

declare const featureIdBrand: unique symbol;
declare const implementationIdBrand: unique symbol;
declare const hostServiceIdBrand: unique symbol;

export type FeatureId = string & { readonly [featureIdBrand]: true };
export type ImplementationId = string & { readonly [implementationIdBrand]: true };
export type HostServiceId = string & { readonly [hostServiceIdBrand]: true };
export type FeatureSupportLevel = 'native' | 'emulated' | 'fallback' | 'unsupported';

export interface ResourceBudget {
  readonly cpuTimeMs: number;
  readonly gpuTimeMs: number;
  readonly cpuMemoryBytes: number;
  readonly gpuMemoryBytes: number;
  readonly uploadBytesPerFrame: number;
  readonly readbackBytesPerFrame: number;
  readonly compileTimeMs: number;
}

export interface QualityImpact {
  readonly tier: string;
  readonly rank: number;
  readonly notes: readonly string[];
}

export type CapabilityPredicate =
  | {
      readonly kind: 'feature';
      readonly feature: RHIFeature;
      readonly statuses: readonly SupportStatus[];
    }
  | { readonly kind: 'limit'; readonly limit: string; readonly minimum: number }
  | {
      readonly kind: 'format';
      readonly format: GPUTextureFormat;
      readonly capability: Exclude<keyof FormatCapabilities, 'sampleCounts'>;
    }
  | {
      readonly kind: 'queue';
      readonly role: RHIQueueRole;
      readonly statuses: readonly SupportStatus[];
    }
  | { readonly kind: 'service'; readonly service: HostServiceId };

export interface PredicateResult {
  readonly predicate: CapabilityPredicate;
  readonly satisfied: boolean;
  readonly actual: unknown;
  readonly reason: string;
}

export interface FeatureDependency {
  readonly feature: FeatureId;
  readonly semanticContract: string;
}

export interface FeatureConflict {
  readonly feature: FeatureId;
  readonly implementations?: readonly ImplementationId[];
}

export interface FeaturePrepareInput {
  readonly capabilities: DeviceCapabilities;
  readonly hostServices: ReadonlySet<HostServiceId>;
  readonly profileId: string;
  readonly deviceGeneration: number;
  readonly budget: ResourceBudget;
}

interface FeatureImplementationBase<Prepared> {
  readonly feature: FeatureId;
  readonly id: ImplementationId;
  readonly version: number;
  readonly support: Exclude<FeatureSupportLevel, 'unsupported'>;
  readonly semanticContract: string;
  readonly requirements: readonly CapabilityPredicate[];
  readonly dependencies: readonly FeatureDependency[];
  readonly conflicts: readonly FeatureConflict[];
  /** Cache identities whose compatibility can change when this implementation is selected. */
  readonly cacheDomains: readonly FeaturePolicyCacheDomain[];
  readonly priority: number;
  readonly quality: QualityImpact;
  estimate(input: FeaturePrepareInput): ResourceBudget;
  prepare(input: FeaturePrepareInput): Promise<Prepared>;
  dispose(prepared: Prepared): void;
}

export interface RuntimeFeatureImplementation<
  Prepared,
  FrameInput = unknown,
  FrameOutput = void
> extends FeatureImplementationBase<Prepared> {
  readonly kind: 'runtime';
  execute(prepared: Prepared, frame: FrameInput): FrameOutput;
}

export interface RenderFeatureImplementation<
  Prepared,
  BuildContext = unknown
> extends FeatureImplementationBase<Prepared> {
  readonly kind: 'render';
  contribute(prepared: Prepared, context: BuildContext): void;
}

export type FeatureImplementation<Prepared = unknown> =
  RuntimeFeatureImplementation<Prepared, unknown, unknown> | RenderFeatureImplementation<Prepared>;

export interface FeatureRequest {
  readonly feature: FeatureId;
  readonly semanticContract: string;
  readonly required: boolean;
  readonly priority: number;
  readonly supportPreference?: readonly Exclude<FeatureSupportLevel, 'unsupported'>[];
}

export interface FeaturePolicyInput {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly profileId: string;
  readonly deviceGeneration: number;
  readonly capabilities: DeviceCapabilities;
  readonly hostServices: ReadonlySet<HostServiceId>;
  readonly budget: ResourceBudget;
  readonly requests: readonly FeatureRequest[];
  readonly implementations: readonly FeatureImplementation[];
}

export type CandidateDisposition =
  | 'eligible'
  | 'rejected-capability'
  | 'rejected-semantic'
  | 'rejected-budget'
  | 'rejected-conflict';

export type DecisionReasonCode =
  | 'selected'
  | 'semantic-mismatch'
  | 'capability-unsatisfied'
  | 'budget-exceeded'
  | 'dependency-unsupported'
  | 'dependency-cycle'
  | 'conflict'
  | 'no-eligible-implementation';

export interface DecisionReason {
  readonly code: DecisionReasonCode;
  readonly message: string;
}

export interface FeatureCandidateEvaluation {
  readonly implementation: ImplementationId;
  readonly implementationVersion: number;
  readonly semanticContract: string;
  readonly capabilityResults: readonly PredicateResult[];
  readonly estimatedBudget: ResourceBudget | null;
  readonly quality: QualityImpact;
  readonly disposition: CandidateDisposition;
  readonly reasons: readonly DecisionReason[];
}

export interface FeatureDecision {
  readonly feature: FeatureId;
  readonly support: FeatureSupportLevel;
  readonly implementation: ImplementationId | null;
  readonly implementationVersion: number | null;
  readonly qualityTier: string | null;
  readonly reasons: readonly DecisionReason[];
  readonly requirements: readonly CapabilityPredicate[];
  readonly estimatedBudget: ResourceBudget;
  readonly cacheDomains: readonly FeaturePolicyCacheDomain[];
}

export interface FeaturePolicySnapshot {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly profileId: string;
  readonly deviceGeneration: number;
  readonly decisions: ReadonlyMap<FeatureId, FeatureDecision>;
  readonly evaluations: ReadonlyMap<FeatureId, readonly FeatureCandidateEvaluation[]>;
  readonly cacheDomainHashes: ReadonlyMap<FeaturePolicyCacheDomain, string>;
  readonly hash: string;
}

/** One cache compatibility identity changed between two published policies. */
export interface FeaturePolicyCacheInvalidation {
  readonly domain: FeaturePolicyCacheDomain;
  readonly previousHash: string | null;
  readonly nextHash: string | null;
}

export interface FeaturePolicyMetrics {
  readonly candidateEvaluations: number;
  readonly predicateEvaluations: number;
  readonly estimateCalls: number;
  readonly dependencyVisits: number;
  readonly selectedFeatures: number;
  readonly unsupportedFeatures: number;
}

export interface FeaturePolicyResolution {
  readonly ok: boolean;
  readonly snapshot: FeaturePolicySnapshot;
  readonly unsupportedRequired: readonly FeatureId[];
  readonly metrics: FeaturePolicyMetrics;
}

/**
 * A fully prepared policy that is safe to publish at a frame boundary.
 *
 * Prepared values are indexed by feature identity and remain owned by the
 * coordinator until the corresponding retirement is released.
 */
export interface PreparedFeaturePolicy {
  readonly snapshot: FeaturePolicySnapshot;
  readonly prepared: ReadonlyMap<FeatureId, unknown>;
}

/** Result of resolving and preparing a policy revision. */
export type FeaturePolicyPrepareResult =
  | {
      readonly ok: true;
      readonly policy: PreparedFeaturePolicy;
      readonly resolution: FeaturePolicyResolution;
    }
  | {
      readonly ok: false;
      readonly resolution: FeaturePolicyResolution;
      readonly error: unknown;
    };

/**
 * Defers disposal of a replaced policy until its submitted GPU work is no
 * longer in flight.
 */
export interface FeaturePolicyRetirement {
  readonly policy: PreparedFeaturePolicy;
  release(): void;
}

/** Result of atomically publishing a prepared policy at a frame boundary. */
export interface FeaturePolicyPublication {
  readonly current: PreparedFeaturePolicy;
  readonly invalidations: readonly FeaturePolicyCacheInvalidation[];
  readonly retirement?: FeaturePolicyRetirement;
}

export interface CapabilityPredicateInput {
  readonly capabilities: DeviceCapabilities;
  readonly hostServices: ReadonlySet<HostServiceId>;
}

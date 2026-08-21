import type {
  DeviceCapabilities,
  FormatCapabilities,
  RHIFeature,
  RHIQueueRole,
  SupportStatus
} from '../../rhi/contracts/capability';
import type { GPUTextureFormat } from '../../rhi/contracts/webgpu';
import type { FeaturePolicyCacheDomain } from '../constants';
import type {
  CapabilityPredicate,
  CandidateDisposition,
  DecisionReason,
  FeatureConflict,
  FeatureDependency,
  FeatureId,
  FeatureRequest,
  FeatureSupportLevel,
  HostServiceId,
  ImplementationId,
  QualityImpact,
  ResourceBudget
} from './feature-policy-types';

export type FeaturePolicyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly FeaturePolicyJsonValue[]
  | { readonly [key: string]: FeaturePolicyJsonValue };

export interface FeaturePolicyInspectionFeatureCapability {
  readonly feature: RHIFeature;
  readonly status: SupportStatus;
  readonly reason?: string;
}

export interface FeaturePolicyInspectionLimit {
  readonly name: string;
  readonly value: number | null;
}

export interface FeaturePolicyInspectionFormatCapability extends FormatCapabilities {
  readonly format: GPUTextureFormat;
}

export interface FeaturePolicyInspectionQueueCapability {
  readonly role: RHIQueueRole;
  readonly status: SupportStatus;
  readonly reason?: string;
}

export interface FeaturePolicyInspectionCapabilities {
  readonly backend: DeviceCapabilities['backend'];
  readonly features: readonly FeaturePolicyInspectionFeatureCapability[];
  readonly limits: readonly FeaturePolicyInspectionLimit[];
  readonly formats: readonly FeaturePolicyInspectionFormatCapability[];
  readonly queues: readonly FeaturePolicyInspectionQueueCapability[];
}

export interface FeaturePolicyInspectionImplementation {
  readonly feature: FeatureId;
  readonly id: ImplementationId;
  readonly version: number;
  readonly kind: 'runtime' | 'render';
  readonly support: Exclude<FeatureSupportLevel, 'unsupported'>;
  readonly semanticContract: string;
  readonly requirements: readonly CapabilityPredicate[];
  readonly dependencies: readonly FeatureDependency[];
  readonly conflicts: readonly FeatureConflict[];
  readonly cacheDomains: readonly FeaturePolicyCacheDomain[];
  readonly priority: number;
  readonly quality: QualityImpact;
}

export interface FeaturePolicyInspectionInput {
  readonly capabilities: FeaturePolicyInspectionCapabilities;
  readonly hostServices: readonly HostServiceId[];
  readonly budget: ResourceBudget;
  readonly requests: readonly FeatureRequest[];
  readonly implementations: readonly FeaturePolicyInspectionImplementation[];
}

export interface FeaturePolicyInspectionPredicateResult {
  readonly predicate: CapabilityPredicate;
  readonly satisfied: boolean;
  readonly actual: FeaturePolicyJsonValue;
  readonly reason: string;
}

export interface FeaturePolicyInspectionCandidate {
  readonly implementation: ImplementationId;
  readonly implementationVersion: number;
  readonly semanticContract: string;
  readonly capabilityResults: readonly FeaturePolicyInspectionPredicateResult[];
  readonly estimatedBudget: ResourceBudget | null;
  readonly quality: QualityImpact;
  readonly disposition: CandidateDisposition;
  readonly reasons: readonly DecisionReason[];
}

export interface FeaturePolicyInspectionDecision {
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

export interface FeaturePolicyInspectionEvaluation {
  readonly feature: FeatureId;
  readonly candidates: readonly FeaturePolicyInspectionCandidate[];
}

export interface FeaturePolicySummary {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly profileId: string;
  readonly deviceGeneration: number;
  readonly hash: string;
  readonly cacheDomainHashes: readonly {
    readonly domain: FeaturePolicyCacheDomain;
    readonly hash: string;
  }[];
}

export interface FeaturePolicyInspection {
  readonly inspectionSchemaVersion: 1;
  readonly policy: FeaturePolicySummary;
  readonly input: FeaturePolicyInspectionInput;
  readonly decisions: readonly FeaturePolicyInspectionDecision[];
  readonly evaluations: readonly FeaturePolicyInspectionEvaluation[];
  readonly unsupportedRequired: readonly FeatureId[];
  readonly metrics: {
    readonly candidateEvaluations: number;
    readonly predicateEvaluations: number;
    readonly estimateCalls: number;
    readonly dependencyVisits: number;
    readonly selectedFeatures: number;
    readonly unsupportedFeatures: number;
  };
}

export interface FeaturePolicyCaptureManifest {
  readonly manifestSchemaVersion: 1;
  readonly policySchemaVersion: number;
  readonly revision: number;
  readonly profileId: string;
  readonly deviceGeneration: number;
  readonly policyHash: string;
  readonly cacheDomainHashes: FeaturePolicySummary['cacheDomainHashes'];
  readonly decisions: readonly FeaturePolicyInspectionDecision[];
  readonly evaluations: readonly FeaturePolicyInspectionEvaluation[];
}

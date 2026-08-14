declare const DynamicPluginIdBrand: unique symbol;
declare const PluginVersionIdBrand: unique symbol;
declare const PluginActivationIdBrand: unique symbol;

export type DynamicPluginId = string & {
  readonly [DynamicPluginIdBrand]: true;
};

export type PluginVersionId = string & {
  readonly [PluginVersionIdBrand]: true;
};

export type PluginActivationId = string & {
  readonly [PluginActivationIdBrand]: true;
};

export type CapabilityId = string;

export type DynamicPluginHostKind = 'editor' | 'preview' | 'asset-worker';

export type DynamicPluginPhase =
  | 'defined'
  | 'validating'
  | 'waiting-approval'
  | 'activating'
  | 'active'
  | 'retracting'
  | 'inactive'
  | 'failed'
  | 'failed-to-quiesce';

export interface DynamicPluginHostRequest {
  readonly kind: DynamicPluginHostKind;
  readonly required: boolean;
}

export interface DynamicCapabilityRequest {
  readonly id: CapabilityId;
  readonly version: number;
  readonly required: boolean;
}

export interface DynamicCapabilityDescriptor {
  readonly id: CapabilityId;
  readonly version: number;
  readonly hostKinds: readonly DynamicPluginHostKind[];
  readonly inheritable: boolean;
}

export interface DynamicPluginManifest {
  readonly schemaVersion: number;
  readonly pluginId: DynamicPluginId;
  readonly versionId: PluginVersionId;
  readonly hosts: readonly DynamicPluginHostRequest[];
  readonly capabilities: readonly DynamicCapabilityRequest[];
}

export interface DynamicPluginVersionVerifier {
  verify(manifest: DynamicPluginManifest): boolean;
}

export interface DynamicPluginPolicy {
  authorize(
    request: DynamicCapabilityRequest,
    hostKind: DynamicPluginHostKind
  ): 'granted' | 'denied';
}

export interface DynamicCapabilityPlan {
  readonly granted: readonly DynamicCapabilityRequest[];
  readonly deniedOptional: readonly DynamicCapabilityRequest[];
}

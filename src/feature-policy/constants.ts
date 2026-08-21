/** Cache identities that a FeaturePolicy implementation may affect. */
export const FeaturePolicyCacheDomain = Object.freeze({
  ShaderPipeline: 'shader-pipeline',
  PreparedAsset: 'prepared-asset',
  CompositionPlan: 'composition-plan',
  History: 'history'
} as const);

export type FeaturePolicyCacheDomain =
  (typeof FeaturePolicyCacheDomain)[keyof typeof FeaturePolicyCacheDomain];
